import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useTheme } from '@/contexts/ThemeContext'
import { Activity, Bot, Phone, Users, Moon, Sun } from 'lucide-react'

export function LandingPage() {
  const navigate = useNavigate()
  const { resolvedTheme, setTheme } = useTheme()
  
  const handleLogin = () => {
    navigate('/login')
  }

  const toggleTheme = () => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/5 via-background to-primary/10">
      <header className="border-b border-border bg-card/80 backdrop-blur-sm">
        <div className="container mx-auto flex h-16 items-center justify-between px-6">
          <h1 className="text-2xl font-bold text-primary">Azul Vision</h1>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              className="h-10 w-10"
              aria-label={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {resolvedTheme === 'dark' ? (
                <Sun className="h-5 w-5 text-yellow-400" />
              ) : (
                <Moon className="h-5 w-5 text-slate-700" />
              )}
            </Button>
            <Button onClick={handleLogin}>Sign In</Button>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-6 py-20">
        <div className="mx-auto max-w-4xl text-center">
          <h2 className="mb-6 text-5xl font-bold text-foreground">
            AI-Powered Operations Hub
          </h2>
          <p className="mb-8 text-xl text-muted-foreground">
            Transform your healthcare operations with intelligent voice agents,
            automated outreach campaigns, and seamless patient communication.
          </p>
          <Button onClick={handleLogin} size="lg" className="px-8 py-6 text-lg">
            Get Started
          </Button>
        </div>

        <div className="mt-20 grid gap-8 md:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg bg-card p-6 shadow-lg border border-border">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
              <Bot className="h-6 w-6 text-primary" />
            </div>
            <h3 className="mb-2 text-lg font-semibold text-card-foreground">Voice Agents</h3>
            <p className="text-muted-foreground">
              Configure and manage intelligent AI voice agents for inbound and
              outbound calls
            </p>
          </div>

          <div className="rounded-lg bg-card p-6 shadow-lg border border-border">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-emerald-500/10">
              <Users className="h-6 w-6 text-emerald-500" />
            </div>
            <h3 className="mb-2 text-lg font-semibold text-card-foreground">Campaign Management</h3>
            <p className="text-muted-foreground">
              Create and monitor outreach campaigns with CSV contact uploads
            </p>
          </div>

          <div className="rounded-lg bg-card p-6 shadow-lg border border-border">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-purple-500/10">
              <Phone className="h-6 w-6 text-purple-500" />
            </div>
            <h3 className="mb-2 text-lg font-semibold text-card-foreground">Call Analytics</h3>
            <p className="text-muted-foreground">
              Track all calls with detailed logs, transcripts, and insights
            </p>
          </div>

          <div className="rounded-lg bg-card p-6 shadow-lg border border-border">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-orange-500/10">
              <Activity className="h-6 w-6 text-orange-500" />
            </div>
            <h3 className="mb-2 text-lg font-semibold text-card-foreground">Callback Queue</h3>
            <p className="text-muted-foreground">
              Manage patient callbacks with priority-based assignment
            </p>
          </div>
        </div>

        <div className="mt-20 rounded-2xl bg-gradient-to-r from-primary to-primary/80 p-12 text-center text-primary-foreground">
          <h3 className="mb-4 text-3xl font-bold">
            Ready to Transform Your Operations?
          </h3>
          <p className="mb-6 text-lg opacity-90">
            Sign in to get started
          </p>
          <Button
            onClick={handleLogin}
            size="lg"
            variant="secondary"
            className="px-8 py-6 text-lg"
          >
            Sign In Now
          </Button>
        </div>
      </main>

      <footer className="border-t border-border bg-card py-8">
        <div className="container mx-auto px-6 text-center text-muted-foreground">
          <p>&copy; 2025 Azul Vision. All rights reserved.</p>
        </div>
      </footer>
    </div>
  )
}
