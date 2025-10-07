import { promises as fs } from 'fs'
import * as path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { prisma } from './db'
import { ensureProjectPublicExposure, cleanupProjectExposure } from './cloudflared'

const execAsync = promisify(exec)

// Helper functions for generating secure defaults
function generateRandomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return result
}

function generateJWT(role: 'anon' | 'service_role', timestamp: number): string {
  // Generate a simple JWT-like token (for demo purposes)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    role,
    iss: 'supabase',
    iat: Math.floor(timestamp / 1000),
    exp: Math.floor(timestamp / 1000) + (365 * 24 * 60 * 60) // 1 year
  })).toString('base64url')
  const signature = generateRandomString(43) // Mock signature
  return `${header}.${payload}.${signature}`
}

// Pre-flight checks for Docker deployment
async function checkDockerPrerequisites() {
  const checks = {
    docker: false,
    dockerCompose: false,
    internetConnection: false,
  }
  
  try {
    await execAsync('docker --version')
    checks.docker = true
  } catch {
    // Docker not available
  }
  
  try {
    await execAsync('docker compose version')
    checks.dockerCompose = true
  } catch {
    // Docker Compose not available
  }
  
  // Multi-layered internet connectivity check
  checks.internetConnection = await checkInternetConnectivity()
  
  return checks
}

// Improved internet connectivity check using multiple methods
async function checkInternetConnectivity(): Promise<boolean> {
  // Method 1: HTTP connectivity test to multiple reliable endpoints
  const httpEndpoints = [
    'https://www.google.com',
    'https://1.1.1.1', // Cloudflare DNS
    'https://8.8.8.8', // Google DNS
  ]
  
  for (const endpoint of httpEndpoints) {
    try {
      // Use curl for HTTP connectivity test with short timeout
      await execAsync(`curl -s --max-time 10 --head ${endpoint}`, { timeout: 15000 })
      return true // If any endpoint succeeds, we have internet
    } catch {
      // Try next endpoint
      continue
    }
  }
  
  // Method 2: DNS resolution test
  try {
    await execAsync('nslookup google.com', { timeout: 10000 })
    return true
  } catch {
    // DNS resolution failed
  }
  
  // Method 3: Ping test (as fallback)
  try {
    const pingCommand = process.platform === 'win32' 
      ? 'ping -n 1 8.8.8.8' 
      : 'ping -c 1 8.8.8.8'
    await execAsync(pingCommand, { timeout: 10000 })
    return true
  } catch {
    // Ping failed
  }
  
  // Method 4: Docker registry connectivity (original method as last resort)
  try {
    await execAsync('docker pull alpine:latest', { 
      timeout: 30000,
      maxBuffer: 1024 * 1024 * 5 // 5MB buffer for Docker pull
    })
    return true
  } catch {
    // All methods failed
  }
  
  return false
}

// Replace fixed host port mappings in docker-compose by env vars with defaults
function injectPortVar(content: string, hostPort: number, containerPort: number, varName: string) {
  const pattern = new RegExp(`-\\s*["']?${hostPort}:${containerPort}["']?`, 'g')
  const replacement = '- ' + '${' + varName + ':-' + hostPort + '}' + ':' + containerPort
  return content.replace(pattern, replacement)
}

async function patchComposePorts(composeFile: string) {
  let content = await fs.readFile(composeFile, 'utf8')

  const before = content

  // Map known Supabase services host ports -> env vars (with docker-compose default fallbacks)
  content = injectPortVar(content, 8000, 8000, 'KONG_HTTP_PORT')
  content = injectPortVar(content, 8443, 8443, 'KONG_HTTPS_PORT')
  content = injectPortVar(content, 3000, 3000, 'STUDIO_PORT')
  content = injectPortVar(content, 4000, 4000, 'ANALYTICS_PORT')
  content = injectPortVar(content, 5432, 5432, 'POSTGRES_PORT')
  content = injectPortVar(content, 6543, 6543, 'POOLER_PROXY_PORT_TRANSACTION')

  if (content !== before) {
    await fs.writeFile(composeFile, content, 'utf8')
  }
}

export async function initializeSupabaseCore() {
  const coreDir = path.join(process.cwd(), 'supabase-core')
  const projectsDir = path.join(process.cwd(), 'supabase-projects')
  
  try {
    // Check if directories already exist
    const coreExists = await fs.access(coreDir).then(() => true).catch(() => false)
    const projectsExists = await fs.access(projectsDir).then(() => true).catch(() => false)
    
    // Create supabase-projects directory if it doesn't exist
    if (!projectsExists) {
      await fs.mkdir(projectsDir, { recursive: true })
    }
    
    // Clone repository if supabase-core doesn't exist
    if (!coreExists) {
      const repoUrl = process.env.SUPABASE_CORE_REPO_URL || 'https://github.com/supabase/supabase'
      
      // Use shallow clone for faster download
      await execAsync(`git clone --depth 1 ${repoUrl} supabase-core`)
    }
    
    return { success: true }
  } catch (error) {
    console.error('Failed to initialize Supabase core:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function createProject(name: string, userId: string, description?: string) {
  try {
    // Generate unique slug
    const timestamp = Date.now()
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${timestamp}`
    
    // Create project in database
    const project = await prisma.project.create({
      data: {
        name,
        slug,
        description,
        ownerId: userId,
      },
    })
    
    // Create project directory
    const projectDir = path.join(process.cwd(), 'supabase-projects', slug)
    const coreDockerDir = path.join(process.cwd(), 'supabase-core', 'docker')
    
    // Copy docker folder from supabase-core
    await fs.mkdir(projectDir, { recursive: true })
    
    // Use cross-platform copy command
    const isWindows = process.platform === 'win32'
    const copyCommand = isWindows 
      ? `xcopy "${coreDockerDir}" "${path.join(projectDir, 'docker')}" /E /I /H /K`
      : `cp -r "${coreDockerDir}" "${projectDir}/"`
      
    await execAsync(copyCommand)
    
    // Customize docker-compose.yml with unique container names
    const dockerComposeFile = path.join(projectDir, 'docker', 'docker-compose.yml')
    let dockerComposeContent = await fs.readFile(dockerComposeFile, 'utf8')
    
    // Replace container names with project-specific names
    const containerMappings = [
      { original: 'supabase-studio', replacement: `${slug}-studio` },
      { original: 'supabase-kong', replacement: `${slug}-kong` },
      { original: 'supabase-auth', replacement: `${slug}-auth` },
      { original: 'supabase-rest', replacement: `${slug}-rest` },
      { original: 'realtime-dev.supabase-realtime', replacement: `realtime-dev.${slug}-realtime` },
      { original: 'supabase-storage', replacement: `${slug}-storage` },
      { original: 'supabase-imgproxy', replacement: `${slug}-imgproxy` },
      { original: 'supabase-meta', replacement: `${slug}-meta` },
      { original: 'supabase-edge-functions', replacement: `${slug}-edge-functions` },
      { original: 'supabase-analytics', replacement: `${slug}-analytics` },
      { original: 'supabase-db', replacement: `${slug}-db` },
      { original: 'supabase-vector', replacement: `${slug}-vector` },
      { original: 'supabase-pooler', replacement: `${slug}-pooler` }
    ]
    
    // Replace container names in the compose file
    for (const mapping of containerMappings) {
      dockerComposeContent = dockerComposeContent.replace(
        new RegExp(`container_name: ${mapping.original}`, 'g'),
        `container_name: ${mapping.replacement}`
      )
    }
    
    // Update the compose project name to be unique
    dockerComposeContent = dockerComposeContent.replace(
      /^name: supabase$/m,
      `name: ${slug}`
    )
    
    // Write the modified docker-compose.yml back
    await fs.writeFile(dockerComposeFile, dockerComposeContent, 'utf8')

    // Ensure host port mappings use env vars (prevents cross-project collisions)
    await patchComposePorts(dockerComposeFile)
    
    // Generate unique default port values to prevent conflicts
    const basePort = 8000 + (timestamp % 10000) // Use last 4 digits of timestamp for uniqueness
    const defaultEnvVars = {
      // Secrets - generated random values
      POSTGRES_PASSWORD: generateRandomString(32),
      JWT_SECRET: generateRandomString(64),
      ANON_KEY: generateJWT('anon', timestamp),
      SERVICE_ROLE_KEY: generateJWT('service_role', timestamp),
      DASHBOARD_USERNAME: 'supabase',
      DASHBOARD_PASSWORD: generateRandomString(16),
      SECRET_KEY_BASE: generateRandomString(64),
      VAULT_ENC_KEY: generateRandomString(32),
      
      // Unique ports to prevent conflicts between projects
      POSTGRES_PORT: (basePort + 2000).toString(),
      POOLER_PROXY_PORT_TRANSACTION: (basePort + 3000).toString(),
      KONG_HTTP_PORT: basePort.toString(),
      KONG_HTTPS_PORT: (basePort + 443).toString(),
      ANALYTICS_PORT: (basePort + 1000).toString(),
      
      // Database
      POSTGRES_HOST: 'db',
      POSTGRES_DB: 'postgres',
      
      // Other defaults
      POOLER_DEFAULT_POOL_SIZE: '20',
      POOLER_MAX_CLIENT_CONN: '100',
      POOLER_TENANT_ID: `project-${timestamp}`,
      POOLER_DB_POOL_SIZE: '5',
      PGRST_DB_SCHEMAS: 'public,storage,graphql_public',
      SITE_URL: `http://localhost:${basePort}`,
      ADDITIONAL_REDIRECT_URLS: '',
      JWT_EXPIRY: '3600',
      DISABLE_SIGNUP: 'false',
      API_EXTERNAL_URL: `http://localhost:${basePort}`,
      MAILER_URLPATHS_CONFIRMATION: '/auth/v1/verify',
      MAILER_URLPATHS_INVITE: '/auth/v1/verify',
      MAILER_URLPATHS_RECOVERY: '/auth/v1/verify',
      MAILER_URLPATHS_EMAIL_CHANGE: '/auth/v1/verify',
      ENABLE_EMAIL_SIGNUP: 'true',
      ENABLE_EMAIL_AUTOCONFIRM: 'false',
      SMTP_ADMIN_EMAIL: 'admin@example.com',
      SMTP_HOST: 'supabase-mail',
      SMTP_PORT: '2500',
      SMTP_USER: 'fake_mail_user',
      SMTP_PASS: 'fake_mail_password',
      SMTP_SENDER_NAME: 'fake_sender',
      ENABLE_ANONYMOUS_USERS: 'false',
      ENABLE_PHONE_SIGNUP: 'true',
      ENABLE_PHONE_AUTOCONFIRM: 'true',
      STUDIO_DEFAULT_ORGANIZATION: 'Default Organization',
      STUDIO_DEFAULT_PROJECT: 'Default Project',
      STUDIO_PORT: (basePort + 100).toString(),
      SUPABASE_PUBLIC_URL: `http://localhost:${basePort}`,
      IMGPROXY_ENABLE_WEBP_DETECTION: 'true',
      OPENAI_API_KEY: '',
      FUNCTIONS_VERIFY_JWT: 'false',
      LOGFLARE_PUBLIC_ACCESS_TOKEN: generateRandomString(64),
      LOGFLARE_PRIVATE_ACCESS_TOKEN: generateRandomString(64),
      DOCKER_SOCKET_LOCATION: '/var/run/docker.sock',
      GOOGLE_PROJECT_ID: 'GOOGLE_PROJECT_ID',
      GOOGLE_PROJECT_NUMBER: 'GOOGLE_PROJECT_NUMBER'
    }
    
    // Write initial .env file with unique defaults
    const envFilePath = path.join(projectDir, 'docker', '.env')
    const envContent = Object.entries(defaultEnvVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
    
    await fs.writeFile(envFilePath, envContent)
    
    // Save environment variables to database
    for (const [key, value] of Object.entries(defaultEnvVars)) {
      await prisma.projectEnvVar.create({
        data: {
          projectId: project.id,
          key,
          value,
        },
      })
    }
    
    return { success: true, project }
  } catch (error) {
    console.error('Failed to create project:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function updateProjectEnvVars(projectId: string, envVars: Record<string, string>) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })
    
    if (!project) {
      throw new Error('Project not found')
    }
    
    // Update environment variables in database
    for (const [key, value] of Object.entries(envVars)) {
      await prisma.projectEnvVar.upsert({
        where: {
          projectId_key: {
            projectId,
            key,
          },
        },
        update: { value },
        create: {
          projectId,
          key,
          value,
        },
      })
    }
    
    // Update .env file in project directory
    const projectDir = path.join(process.cwd(), 'supabase-projects', project.slug, 'docker')
    const envFilePath = path.join(projectDir, '.env')
    
    const envContent = Object.entries(envVars)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n')
    
    await fs.writeFile(envFilePath, envContent)
    
    return { success: true }
  } catch (error) {
    console.error('Failed to update project env vars:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function deployProject(projectId: string) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })
    
    if (!project) {
      throw new Error('Project not found')
    }
    
    const projectDir = path.join(process.cwd(), 'supabase-projects', project.slug, 'docker')
    const composeFile = path.join(projectDir, 'docker-compose.yml')

    // Ensure host port mappings use env vars (idempotent patch for existing projects)
    try {
      await patchComposePorts(composeFile)
    } catch (e) {
      console.warn('Could not patch docker-compose.yml ports:', e)
    }
    
    // Run pre-flight checks
    console.log('Running pre-flight checks...')
    const checks = await checkDockerPrerequisites()
    
    if (!checks.docker) {
      throw new Error('Docker is not installed or not running. Please install Docker Desktop and ensure it is started before deploying.')
    }
    
    if (!checks.dockerCompose) {
      throw new Error('Docker Compose is not available. Please ensure Docker Desktop includes Docker Compose or install it separately.')
    }
    
    // Try to run Docker commands with better error handling
    try {
      // Only pull images if we have internet connectivity
      if (checks.internetConnection) {
        console.log('Attempting to pull latest Docker images...')
        try {
          await execAsync('docker compose pull', { 
            cwd: projectDir, 
            timeout: 300000, // 5 minute timeout
            maxBuffer: 1024 * 1024 * 10 // 10MB buffer
          })
        } catch (pullError) {
          console.warn('Failed to pull some images, will try to use existing/cached images:', pullError)
          // Continue with deployment even if pull fails
        }
      } else {
        console.warn('No internet connectivity detected, using cached Docker images')
      }
      
      // Start the services
      console.log('Starting Supabase services...')
      await execAsync('docker compose up -d --remove-orphans', { 
        cwd: projectDir, 
        timeout: 300000, // 5 minute timeout
        maxBuffer: 1024 * 1024 * 10 // 10MB buffer
      })
      
    } catch (composeError) {
      // If the main docker compose command fails, provide better error message
      const errorMessage = composeError instanceof Error ? composeError.message : 'Unknown Docker error'
      
      if (errorMessage.includes('maxBuffer length exceeded')) {
        throw new Error('Docker deployment generated too much output. This usually means the deployment is working but Docker is downloading many large images. Please wait a few more minutes and check Docker Desktop to see if containers are starting. You can also try running "docker compose up -d" manually in the project directory.')
      } else if (errorMessage.includes('no such host') || errorMessage.includes('dial tcp')) {
        throw new Error('Network connectivity issue: Unable to reach Docker registry. This might be due to:\n\n1. Internet connection issues\n2. Corporate firewall blocking Docker registry\n3. DNS resolution problems\n\nSolution: Try running "docker pull supabase/postgres" manually to test connectivity, or work with your IT team to allow access to Docker Hub.')
      } else if (errorMessage.includes('permission denied')) {
        throw new Error('Docker permission denied. Please ensure:\n\n1. Docker Desktop is running\n2. Your user is in the "docker" group (Linux/Mac)\n3. You have administrator privileges (Windows)')
      } else if (errorMessage.includes('not found')) {
        throw new Error('Docker or Docker Compose not found. Please install Docker Desktop from https://docker.com/products/docker-desktop')
      } else if (errorMessage.includes('image') && errorMessage.includes('not found')) {
        throw new Error('Required Docker images not found. Please ensure you have internet connectivity and try again, or manually pull images with "docker compose pull"')
      } else {
        throw new Error(`Docker deployment failed: ${errorMessage}`)
      }
    }
    
    // Verify that containers are running
    try {
      const { stdout } = await execAsync('docker compose ps --format json', { 
        cwd: projectDir,
        maxBuffer: 1024 * 1024 * 2 // 2MB buffer for container status
      })
      const containers = JSON.parse(`[${stdout.trim().split('\n').join(',')}]`)
      const runningContainers = containers.filter((c: { State: string }) => c.State === 'running')
      console.log(`Deployment successful: ${runningContainers.length} containers running`)
    } catch {
      console.warn('Could not verify container status, but deployment may have succeeded')
    }

    // Determine internal service URL (port mode by default, proxy mode if INTERNAL_REVERSE_PROXY_URL exists)
    const envVars = await prisma.projectEnvVar.findMany({
      where: { projectId },
    })
    const varMap = Object.fromEntries(envVars.map(v => [v.key, v.value]))
    const portStr = varMap['KONG_HTTP_PORT'] || varMap['STUDIO_PORT'] || varMap['POSTGRES_PORT']
    const port = portStr ? parseInt(portStr, 10) : undefined
    const internalProxy = process.env.INTERNAL_REVERSE_PROXY_URL && process.env.INTERNAL_REVERSE_PROXY_URL.trim().length > 0
      ? process.env.INTERNAL_REVERSE_PROXY_URL
      : undefined

    // Cloudflared integration (DNS + ingress + reload)
    const exposure = await ensureProjectPublicExposure({
      projectName: project.name,
      projectSlug: project.slug,
      port,
      internalUrl: internalProxy,
    })

    // Persist public hostname/url as env vars for UI/records
    await prisma.projectEnvVar.upsert({
      where: { projectId_key: { projectId, key: 'PUBLIC_HOSTNAME' } },
      update: { value: exposure.hostname },
      create: { projectId, key: 'PUBLIC_HOSTNAME', value: exposure.hostname },
    })
    await prisma.projectEnvVar.upsert({
      where: { projectId_key: { projectId, key: 'PUBLIC_URL' } },
      update: { value: exposure.publicUrl },
      create: { projectId, key: 'PUBLIC_URL', value: exposure.publicUrl },
    })
    
    // Update project status
    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'active' },
    })
    
    // Log public URL
    console.log(`Public URL for project ${project.slug}: ${exposure.publicUrl}`)
    
    return { success: true, publicUrl: exposure.publicUrl }
  } catch (error) {
    console.error('Failed to deploy project:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function pauseProject(projectId: string) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })
    
    if (!project) {
      throw new Error('Project not found')
    }
    
    const projectDir = path.join(process.cwd(), 'supabase-projects', project.slug, 'docker')
    
    // Stop Docker containers
    await execAsync('docker compose stop', { cwd: projectDir })
    
    // Update project status
    await prisma.project.update({
      where: { id: projectId },
      data: { status: 'paused' },
    })
    
    return { success: true }
  } catch (error) {
    console.error('Failed to pause project:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}

export async function deleteProject(projectId: string) {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    })
    
    if (!project) {
      throw new Error('Project not found')
    }
    
    const projectDir = path.join(process.cwd(), 'supabase-projects', project.slug)
    const dockerDir = path.join(projectDir, 'docker')
    
    // Step 1: Stop and remove Docker containers
    try {
      console.log(`Stopping Docker containers for project ${project.slug}...`)
      await execAsync('docker compose down --volumes --remove-orphans', { 
        cwd: dockerDir,
        timeout: 120000, // 2 minutes timeout
        maxBuffer: 1024 * 1024 * 5 // 5MB buffer
      })
    } catch (dockerError) {
      console.warn('Failed to stop Docker containers (they may not be running):', dockerError)
      // Continue with deletion even if Docker cleanup fails
    }

    // Step 2: Cloudflare DNS + cloudflared ingress cleanup
    try {
      await cleanupProjectExposure({ projectSlug: project.slug, projectName: project.name })
    } catch (exposureError) {
      console.warn('Failed to cleanup Cloudflare/cloudflared:', exposureError)
    }
    
    // Step 3: Remove project directory
    try {
      console.log(`Removing project directory: ${projectDir}`)
      const isWindows = process.platform === 'win32'
      const removeCommand = isWindows 
        ? `rmdir /s /q "${projectDir}"` 
        : `rm -rf "${projectDir}"`
      
      await execAsync(removeCommand, { timeout: 60000 })
    } catch (fsError) {
      console.warn('Failed to remove project directory:', fsError)
      // Continue with database cleanup even if filesystem cleanup fails
    }
    
    // Step 4: Clean up database records
    try {
      // Delete project environment variables
      await prisma.projectEnvVar.deleteMany({
        where: { projectId },
      })
      
      // Delete the project itself
      await prisma.project.delete({
        where: { id: projectId },
      })
    } catch (dbError) {
      console.error('Failed to clean up database records:', dbError)
      throw new Error('Failed to remove project from database')
    }
    
    console.log(`Project ${project.slug} deleted successfully`)
    return { success: true }
  } catch (error) {
    console.error('Failed to delete project:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
}