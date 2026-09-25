import { type ReactNode, createContext, useContext } from 'react'
import type { ApiClient } from './client'

const ClientContext = createContext<ApiClient | null>(null)

export function ClientProvider({ client, children }: { client: ApiClient; children: ReactNode }) {
  return <ClientContext.Provider value={client}>{children}</ClientContext.Provider>
}

/** The client the application was given. A screen rendered outside a provider is a defect, said loudly. */
export function useClient(): ApiClient {
  const c = useContext(ClientContext)
  if (c === null) throw new Error('useClient outside a ClientProvider')
  return c
}
