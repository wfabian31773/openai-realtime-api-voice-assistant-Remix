import { useQuery } from '@tanstack/react-query'
import apiClient from '@/lib/apiClient'

export interface User {
  id: string
  email: string
  firstName: string
  lastName: string
  profileImageUrl?: string
  role: string
}

async function fetchCurrentUser(): Promise<User | null> {
  try {
    const { data } = await apiClient.get<User>('/auth/user')
    console.log('[useAuth] User authenticated:', data)
    return data
  } catch (error) {
    console.log('[useAuth] Not authenticated (expected for logged out users)')
    return null
  }
}

export function useAuth() {
  const { data: user, isLoading, error, refetch } = useQuery({
    queryKey: ['auth', 'user'],
    queryFn: fetchCurrentUser,
    retry: false,
  })

  return {
    user,
    isAuthenticated: !!user,
    isLoading,
    error,
    refetch,
  }
}
