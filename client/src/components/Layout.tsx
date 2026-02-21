import { Link, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useTheme } from '@/contexts/ThemeContext'
import { Button } from '@/components/ui/button'
import {
  LayoutDashboard,
  Bot,
  Megaphone,
  Phone,
  MessageSquare,
  ClipboardList,
  LogOut,
  Menu,
  X,
  FlaskConical,
  Activity,
  Calendar,
  BookOpen,
  DollarSign,
  Users,
  AlertTriangle,
  Moon,
  Sun,
  Settings2,
} from 'lucide-react'
import { useState } from 'react'

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Urgent Calls', href: '/urgent-calls', icon: AlertTriangle },
  { name: 'Live Calls', href: '/live-calls', icon: Activity },
  { name: 'Agents', href: '/agents', icon: Bot },
  { name: 'Campaigns', href: '/campaigns', icon: Megaphone },
  { name: 'Scheduling Monitor', href: '/scheduling-monitor', icon: Calendar },
  { name: 'Cost Dashboard', href: '/cost-dashboard', icon: DollarSign },
  { name: 'Call Logs', href: '/call-logs', icon: Phone },
  { name: 'SMS Logs', href: '/sms-logs', icon: MessageSquare },
  { name: 'Callback Queue', href: '/callback-queue', icon: ClipboardList },
  { name: 'Documentation', href: '/documentation', icon: BookOpen },
  { name: 'Testing', href: '/testing', icon: FlaskConical },
]

const adminNavigation = [
  { name: 'Operations Monitor', href: '/operations', icon: Activity, roles: ['admin'] },
  { name: 'Twilio Config', href: '/twilio', icon: Settings2, roles: ['admin'] },
  { name: 'User Management', href: '/users', icon: Users, roles: ['admin', 'manager'] },
]

export function Layout() {
  const { user } = useAuth()
  const { resolvedTheme, setTheme } = useTheme()
  const location = useLocation()
  const [sidebarOpen, setSidebarOpen] = useState(false)

  const handleLogout = () => {
    window.location.href = '/api/auth/logout'
  }

  const toggleTheme = () => {
    setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')
  }

  return (
    <div className="flex h-screen bg-background">
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <div
        className={`fixed inset-y-0 left-0 z-50 w-64 transform bg-card shadow-lg transition-transform duration-300 ease-in-out lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-full flex-col">
          <div className="flex h-16 items-center justify-between border-b border-border px-6">
            <h1 className="text-xl font-bold text-primary">Azul Vision</h1>
            <button
              className="lg:hidden text-foreground"
              onClick={() => setSidebarOpen(false)}
            >
              <X className="h-6 w-6" />
            </button>
          </div>

          <nav className="flex-1 space-y-1 px-3 py-4 overflow-y-auto">
            {navigation.map((item) => {
              const isActive = location.pathname === item.href
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  onClick={() => setSidebarOpen(false)}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  }`}
                >
                  <item.icon className="h-5 w-5" />
                  {item.name}
                </Link>
              )
            })}
            
            {adminNavigation
              .filter((item) => user?.role && item.roles.includes(user.role))
              .map((item) => {
                const isActive = location.pathname === item.href
                return (
                  <Link
                    key={item.name}
                    to={item.href}
                    onClick={() => setSidebarOpen(false)}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }`}
                  >
                    <item.icon className="h-5 w-5" />
                    {item.name}
                  </Link>
                )
              })}
          </nav>

          <div className="border-t border-border p-4">
            <div className="mb-3 flex items-center gap-3">
              {user?.profileImageUrl && (
                <img
                  src={user.profileImageUrl}
                  alt={user.firstName}
                  className="h-10 w-10 rounded-full"
                />
              )}
              <div className="flex-1 overflow-hidden">
                <p className="truncate text-sm font-medium text-foreground">
                  {user?.firstName} {user?.lastName}
                </p>
                <p className="truncate text-xs text-muted-foreground">{user?.email}</p>
              </div>
            </div>
            <Button
              onClick={handleLogout}
              variant="outline"
              className="w-full"
              size="sm"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Logout
            </Button>
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-16 items-center justify-between border-b border-border bg-card px-6 shadow-sm">
          <div className="flex items-center gap-4">
            <button
              className="lg:hidden text-foreground"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="h-6 w-6" />
            </button>
            <h2 className="text-lg font-semibold text-foreground">
              AI Operations Hub
            </h2>
          </div>
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
        </header>

        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
