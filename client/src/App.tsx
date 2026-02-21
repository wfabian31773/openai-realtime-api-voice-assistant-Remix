import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from '@/lib/queryClient'
import { ToastProvider } from '@/components/ui/toast'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { useAuth } from '@/hooks/useAuth'
import { Layout } from '@/components/Layout'
import { LandingPage } from '@/pages/LandingPage'
import { LoginPage } from '@/pages/LoginPage'
import { ForgotPasswordPage } from '@/pages/ForgotPasswordPage'
import { ResetPasswordPage } from '@/pages/ResetPasswordPage'
import { AcceptInvitePage } from '@/pages/AcceptInvitePage'
import { Dashboard } from '@/pages/Dashboard'
import { AgentsPage } from '@/pages/AgentsPage'
import { CampaignsPage } from '@/pages/CampaignsPage'
import { CallLogsPage } from '@/pages/CallLogsPage'
import { CallDetailsPage } from '@/pages/CallDetailsPage'
import { SmsLogsPage } from '@/pages/SmsLogsPage'
import { CallbackQueuePage } from '@/pages/CallbackQueuePage'
import { LiveCallsPage } from '@/pages/LiveCallsPage'
import { SchedulingMonitorPage } from '@/pages/SchedulingMonitorPage'
import { DocumentationPage } from '@/pages/DocumentationPage'
import { CostDashboardPage } from '@/pages/CostDashboardPage'
import { UserManagementPage } from '@/pages/UserManagementPage'
import { UrgentCallsPage } from '@/pages/UrgentCallsPage'
import { TwilioPage } from '@/pages/TwilioPage'
import TestingPage from '@/pages/TestingPage'
import { OperationsMonitorPage } from '@/pages/OperationsMonitorPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/welcome" replace />
  }

  return <>{children}</>
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}

function RoleProtectedRoute({ 
  children, 
  allowedRoles 
}: { 
  children: React.ReactNode
  allowedRoles: string[] 
}) {
  const { user, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="text-center">
          <div className="mb-4 h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  if (!user?.role || !allowedRoles.includes(user.role)) {
    return <Navigate to="/" replace />
  }

  return <>{children}</>
}

function AppRoutes() {
  return (
    <Routes>
      {/* Public auth routes */}
      <Route
        path="/welcome"
        element={
          <PublicRoute>
            <LandingPage />
          </PublicRoute>
        }
      />
      <Route
        path="/login"
        element={
          <PublicRoute>
            <LoginPage />
          </PublicRoute>
        }
      />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      
      {/* Protected routes */}
      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/call-logs" element={<CallLogsPage />} />
        <Route path="/call-logs/:id" element={<CallDetailsPage />} />
        <Route path="/urgent-calls" element={<UrgentCallsPage />} />
        <Route path="/sms-logs" element={<SmsLogsPage />} />
        <Route path="/callback-queue" element={<CallbackQueuePage />} />
        <Route path="/live-calls" element={<LiveCallsPage />} />
        <Route path="/scheduling-monitor" element={<SchedulingMonitorPage />} />
        <Route path="/cost-dashboard" element={<CostDashboardPage />} />
        <Route path="/documentation" element={<DocumentationPage />} />
        <Route path="/testing" element={<TestingPage />} />
        <Route 
          path="/operations" 
          element={
            <RoleProtectedRoute allowedRoles={['admin']}>
              <OperationsMonitorPage />
            </RoleProtectedRoute>
          } 
        />
        <Route 
          path="/twilio" 
          element={
            <RoleProtectedRoute allowedRoles={['admin']}>
              <TwilioPage />
            </RoleProtectedRoute>
          } 
        />
        <Route 
          path="/users" 
          element={
            <RoleProtectedRoute allowedRoles={['admin', 'manager']}>
              <UserManagementPage />
            </RoleProtectedRoute>
          } 
        />
      </Route>
    </Routes>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <BrowserRouter>
              <AppRoutes />
            </BrowserRouter>
          </ToastProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
