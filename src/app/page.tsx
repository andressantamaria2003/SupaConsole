'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function HomePage() {
  const router = useRouter()

  useEffect(() => {
    // Check if user is logged in by trying to fetch projects
    fetch('/api/projects')
      .then((response) => {
        if (response.ok) {
          router.push('/dashboard')
        } else {
          router.push('/auth/login')
        }
      })
      .catch(() => {
        router.push('/auth/login')
      })
  }, [router])

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div>Loading...</div>
    </div>
  )
}
