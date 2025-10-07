import { promises as fs } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { exec } from 'child_process'
import { promisify } from 'util'
import YAML from 'yaml'

const execAsync = promisify(exec)

type EnsureExposureArgs = {
  projectName: string
  projectSlug: string
  port?: number
  internalUrl?: string
}

type EnsureExposureResult = {
  hostname: string
  publicUrl: string
}

function sanitizeSlug(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

function getEnvOrThrow(key: string): string {
  const v = process.env[key]
  if (!v) throw new Error(`Missing required environment variable: ${key}`)
  return v
}

async function ensureCloudflareCname(hostname: string, target: string) {
  const token = getEnvOrThrow('CF_API_TOKEN')
  const zoneId = getEnvOrThrow('CF_ZONE_ID')

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  }

  const listUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`
  const listResp = await fetch(listUrl, { headers })
  if (!listResp.ok) {
    const text = await listResp.text()
    throw new Error(`Cloudflare API error (list DNS): ${listResp.status} ${text}`)
  }
  const listData = await listResp.json() as { success: boolean; result: Array<{ id: string; content: string; proxied: boolean }> }
  const existing = listData.result?.[0]

  if (existing) {
    if (existing.content !== target || existing.proxied !== true) {
      const updateUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${existing.id}`
      const updateResp = await fetch(updateUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          type: 'CNAME',
          name: hostname,
          content: target,
          ttl: 1,
          proxied: true,
        }),
      })
      if (!updateResp.ok) {
        const text = await updateResp.text()
        throw new Error(`Cloudflare API error (update DNS): ${updateResp.status} ${text}`)
      }
    }
  } else {
    const createUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`
    const createResp = await fetch(createUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'CNAME',
        name: hostname,
        content: target,
        ttl: 1,
        proxied: true,
      }),
    })
    if (!createResp.ok) {
      const text = await createResp.text()
      throw new Error(`Cloudflare API error (create DNS): ${createResp.status} ${text}`)
    }
  }
}

async function deleteCloudflareCname(hostname: string) {
  const token = getEnvOrThrow('CF_API_TOKEN')
  const zoneId = getEnvOrThrow('CF_ZONE_ID')

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  }

  const listUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}`
  const listResp = await fetch(listUrl, { headers })
  if (!listResp.ok) {
    const text = await listResp.text()
    throw new Error(`Cloudflare API error (list DNS): ${listResp.status} ${text}`)
  }
  const listData = await listResp.json() as { success: boolean; result: Array<{ id: string }> }
  const id = listData.result?.[0]?.id
  if (!id) return

  const delUrl = `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${id}`
  const delResp = await fetch(delUrl, { method: 'DELETE', headers })
  if (!delResp.ok) {
    const text = await delResp.text()
    throw new Error(`Cloudflare API error (delete DNS): ${delResp.status} ${text}`)
  }
}

function getConfigPath(): string {
  const envPath = process.env.CF_TUNNEL_CONFIG_PATH
  if (envPath && envPath.trim().length > 0) return envPath
  return path.join(os.homedir(), '.cloudflared', 'config.yml')
}

async function readYamlFile(filePath: string): Promise<any> {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return YAML.parse(content) || {}
  } catch {
    return {}
  }
}

async function writeYamlFile(filePath: string, data: any): Promise<void> {
  const dir = path.dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const yaml = YAML.stringify(data)
  await fs.writeFile(filePath, yaml, 'utf8')
}

// Normaliza la lista de ingress: elimina duplicados de 404 y garantiza un único 404 al final
function ensureCatchAll404(ingress: any[]) {
  const items = Array.isArray(ingress) ? ingress : []
  const without404 = items.filter((r) => !(r && typeof r === 'object' && r.service === 'http_status:404'))
  return [...without404, { service: 'http_status:404' }]
}

async function tryExec(cmd: string): Promise<boolean> {
  try {
    await execAsync(cmd)
    return true
  } catch {
    return false
  }
}

async function isProcessRunningCloudflared(): Promise<boolean> {
  if (process.platform === 'win32') {
    return await tryExec('tasklist /FI "IMAGENAME eq cloudflared.exe" | find /I "cloudflared.exe"')
  }
  return await tryExec('pgrep -x cloudflared >/dev/null 2>&1') || await tryExec('pgrep -f "cloudflared.*tunnel" >/dev/null 2>&1')
}

async function reloadCloudflared(configPath: string, tunnelUuid: string) {
  if (process.platform !== 'win32' && (await tryExec('command -v systemctl >/dev/null 2>&1'))) {
    if (await tryExec('systemctl reload cloudflared')) return
    if (await tryExec('systemctl restart cloudflared')) return
  }
  if (process.platform !== 'win32' && (await tryExec('command -v service >/dev/null 2>&1'))) {
    if (await tryExec('service cloudflared reload')) return
    if (await tryExec('service cloudflared restart')) return
  }
  if (process.platform === 'win32') {
    const hasSc = await tryExec('sc query cloudflared >NUL 2>&1')
    if (hasSc) {
      await tryExec('sc stop cloudflared')
      await tryExec('sc start cloudflared')
      return
    }
  }
  if (process.platform !== 'win32') {
    if (await tryExec('pkill -HUP -x cloudflared')) return
    if (await tryExec('pkill -HUP -f "cloudflared.*tunnel"')) return
  }
  const running = await isProcessRunningCloudflared()
  if (!running) {
    const cmd = `cloudflared --config "${configPath}" tunnel run ${tunnelUuid}`
    if (process.platform === 'win32') {
      await tryExec(`start "" /B ${cmd}`)
    } else {
      await tryExec(`nohup ${cmd} >/dev/null 2>&1 &`)
    }
  }
}

async function ensureTunnelIngress(hostname: string, serviceUrl: string, tunnelUuid: string) {
  const configPath = getConfigPath()
  const config = await readYamlFile(configPath)

  if (!config.tunnel || config.tunnel !== tunnelUuid) {
    config.tunnel = tunnelUuid
  }
  if (!Array.isArray(config.ingress)) {
    config.ingress = []
  }

  // Reemplaza cualquier regla previa del mismo hostname y agrega la nueva
  config.ingress = (config.ingress as any[]).filter((r: any) => !(r && r.hostname && String(r.hostname).toLowerCase() === hostname.toLowerCase()))
  config.ingress.push({ hostname, service: serviceUrl })

  config.ingress = ensureCatchAll404(config.ingress)

  await writeYamlFile(configPath, config)

  try {
    await execAsync(`cloudflared tunnel ingress validate -f "${configPath}"`)
  } catch {
    await execAsync(`cloudflared tunnel ingress validate --config "${configPath}"`)
  }

  await reloadCloudflared(configPath, tunnelUuid)
}

async function removeTunnelIngress(hostname: string, tunnelUuid: string) {
  const configPath = getConfigPath()
  const config = await readYamlFile(configPath)

  if (Array.isArray(config.ingress)) {
    // Elimina reglas del hostname (case-insensitive)
    const filtered = (config.ingress as any[]).filter((r: any) => !(r && r.hostname && String(r.hostname).toLowerCase() === hostname.toLowerCase()))
    // Normaliza dejando un único 404 al final
    config.ingress = ensureCatchAll404(filtered)

    await writeYamlFile(configPath, config)

    try {
      await execAsync(`cloudflared tunnel ingress validate -f "${configPath}"`)
    } catch {
      await execAsync(`cloudflared tunnel ingress validate --config "${configPath}"`)
    }

    await reloadCloudflared(configPath, tunnelUuid)
  }
}

export async function ensureProjectPublicExposure(args: EnsureExposureArgs): Promise<EnsureExposureResult> {
  const baseDomain = getEnvOrThrow('BASE_DOMAIN')
  const tunnelUuid = getEnvOrThrow('CF_TUNNEL_UUID')

  const projectSlug = sanitizeSlug(args.projectSlug || args.projectName)
  const hostname = `${projectSlug}.${baseDomain}`

  let serviceUrl: string | undefined = undefined
  if (args.internalUrl && args.internalUrl.trim().length > 0) {
    serviceUrl = args.internalUrl
  } else if (process.env.INTERNAL_REVERSE_PROXY_URL && process.env.INTERNAL_REVERSE_PROXY_URL.trim().length > 0) {
    serviceUrl = process.env.INTERNAL_REVERSE_PROXY_URL
  } else if (args.port) {
    serviceUrl = `http://127.0.0.1:${args.port}`
  } else {
    throw new Error('Cannot determine service URL: provide internalUrl or port')
  }

  const tunnelDnsTarget = `${tunnelUuid}.cfargotunnel.com`
  await ensureCloudflareCname(hostname, tunnelDnsTarget)
  await ensureTunnelIngress(hostname, serviceUrl, tunnelUuid)

  const publicUrl = `https://${hostname}`
  console.log(`Cloudflared exposure ready: ${publicUrl} -> ${serviceUrl}`)
  return { hostname, publicUrl }
}

export async function cleanupProjectExposure(args: { projectSlug?: string; projectName?: string }) {
  const baseDomain = getEnvOrThrow('BASE_DOMAIN')
  const tunnelUuid = getEnvOrThrow('CF_TUNNEL_UUID')

  const slugOrName = args.projectSlug || args.projectName
  if (!slugOrName) throw new Error('cleanupProjectExposure requires projectSlug or projectName')

  const projectSlug = sanitizeSlug(slugOrName)
  const hostname = `${projectSlug}.${baseDomain}`

  try {
    await deleteCloudflareCname(hostname)
  } catch (e) {
    console.warn(`Cloudflare DNS cleanup warning for ${hostname}:`, e)
  }

  try {
    await removeTunnelIngress(hostname, tunnelUuid)
  } catch (e) {
    console.warn(`cloudflared ingress cleanup warning for ${hostname}:`, e)
  }
}