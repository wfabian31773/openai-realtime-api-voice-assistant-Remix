import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, User, Calendar, CheckCircle, XCircle, Loader2, Eye, Phone, Pause, Play } from 'lucide-react';

interface SchedulingWorkflow {
  id: string;
  callLogId: string;
  campaignId: string | null;
  contactId: string | null;
  agentId: string | null;
  status: 'initiated' | 'collecting_data' | 'form_filling' | 'otp_requested' | 'otp_verified' | 'submitting' | 'completed' | 'failed' | 'cancelled';
  patientData: any;
  currentStep: string | null;
  formProgress: any;
  screenshots: string[];
  otpRequested: boolean;
  otpCode: string | null;
  errorMessage: string | null;
  confirmationNumber: string | null;
  appointmentDetails: any;
  manualOverrideEnabled: boolean;
  operatorId: string | null;
  operatorNotes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const STATUS_CONFIG = {
  initiated: { label: 'Starting', color: 'bg-blue-100 text-blue-800', icon: Loader2 },
  collecting_data: { label: 'Collecting Info', color: 'bg-blue-100 text-blue-800', icon: User },
  form_filling: { label: 'Filling Form', color: 'bg-purple-100 text-purple-800', icon: Calendar },
  otp_requested: { label: 'Waiting for OTP', color: 'bg-yellow-100 text-yellow-800', icon: Phone },
  otp_verified: { label: 'OTP Verified', color: 'bg-green-100 text-green-800', icon: CheckCircle },
  submitting: { label: 'Submitting', color: 'bg-blue-100 text-blue-800', icon: Loader2 },
  completed: { label: 'Completed', color: 'bg-green-100 text-green-800', icon: CheckCircle },
  failed: { label: 'Failed', color: 'bg-red-100 text-red-800', icon: XCircle },
  cancelled: { label: 'Cancelled', color: 'bg-muted text-foreground', icon: XCircle },
};

export function SchedulingMonitorPage() {
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filter, setFilter] = useState<'all' | 'active'>('active');

  // Fetch workflows with auto-refresh
  const { data: workflows, isLoading, refetch } = useQuery<SchedulingWorkflow[]>({
    queryKey: ['scheduling-workflows', filter],
    queryFn: async () => {
      const endpoint = filter === 'active' 
        ? '/api/scheduling-workflows/active'
        : '/api/scheduling-workflows';
      const res = await fetch(endpoint, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch workflows');
      return res.json();
    },
    refetchInterval: autoRefresh ? 3000 : false, // Refresh every 3 seconds
  });

  // Fetch selected workflow details
  const { data: selectedWorkflowData } = useQuery<SchedulingWorkflow>({
    queryKey: ['scheduling-workflow', selectedWorkflow],
    queryFn: async () => {
      if (!selectedWorkflow) throw new Error('No workflow selected');
      const res = await fetch(`/api/scheduling-workflows/${selectedWorkflow}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch workflow');
      return res.json();
    },
    enabled: !!selectedWorkflow,
    refetchInterval: autoRefresh ? 2000 : false, // Refresh details every 2 seconds
  });

  const handlePauseWorkflow = async (workflowId: string) => {
    const notes = prompt('Optional: Add a note explaining why you are pausing this workflow:');
    
    try {
      const res = await fetch(`/api/scheduling-workflows/${workflowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          manualOverrideEnabled: true,
          operatorNotes: notes || 'Paused by operator'
        }),
      });
      
      if (!res.ok) throw new Error('Failed to pause workflow');
      refetch();
    } catch (error) {
      alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleResumeWorkflow = async (workflowId: string) => {
    if (!confirm('Resume automatic form filling?')) return;
    
    try {
      const res = await fetch(`/api/scheduling-workflows/${workflowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ 
          manualOverrideEnabled: false,
          operatorNotes: null
        }),
      });
      
      if (!res.ok) throw new Error('Failed to resume workflow');
      refetch();
    } catch (error) {
      alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleCancelWorkflow = async (workflowId: string) => {
    if (!confirm('Are you sure you want to cancel this scheduling session?')) return;
    
    try {
      const res = await fetch(`/api/scheduling-workflows/${workflowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: 'cancelled' }),
      });
      
      if (!res.ok) throw new Error('Failed to cancel workflow');
      refetch();
    } catch (error) {
      alert(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const formatTimestamp = (date: Date | string) => {
    return new Date(date).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const getTimeSince = (date: Date | string) => {
    const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  };

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-foreground">Scheduling Monitor</h1>
            <p className="text-muted-foreground mt-1">Live form-filling automation with Computer Use</p>
          </div>
          
          <div className="flex items-center gap-4">
            {/* Filter Toggle */}
            <div className="flex bg-muted rounded-lg p-1">
              <button
                onClick={() => setFilter('active')}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  filter === 'active'
                    ? 'bg-white text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Active ({workflows?.filter((w: SchedulingWorkflow) => !['completed', 'failed', 'cancelled'].includes(w.status)).length || 0})
              </button>
              <button
                onClick={() => setFilter('all')}
                className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  filter === 'all'
                    ? 'bg-white text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                All ({workflows?.length || 0})
              </button>
            </div>

            {/* Auto-refresh Toggle */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
              />
              <span className="text-sm text-foreground">Auto-refresh</span>
            </label>
          </div>
        </div>
      </div>

      {/* Workflows Grid */}
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        </div>
      ) : workflows && workflows.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Workflows List */}
          <div className="space-y-4">
            {workflows.map((workflow: SchedulingWorkflow) => {
              const statusConfig = STATUS_CONFIG[workflow.status as keyof typeof STATUS_CONFIG];
              const StatusIcon = statusConfig.icon;
              const isActive = !['completed', 'failed', 'cancelled'].includes(workflow.status);

              return (
                <div
                  key={workflow.id}
                  className={`bg-white rounded-lg border-2 transition-all cursor-pointer ${
                    selectedWorkflow === workflow.id
                      ? 'border-blue-500 shadow-lg'
                      : 'border-border hover:border-border'
                  }`}
                  onClick={() => setSelectedWorkflow(workflow.id)}
                >
                  <div className="p-4">
                    {/* Status Header */}
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${statusConfig.color}`}>
                          <StatusIcon className={`w-3.5 h-3.5 ${isActive ? 'animate-spin' : ''}`} />
                          {statusConfig.label}
                        </span>
                        {workflow.otpRequested && workflow.status === 'otp_requested' && (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-yellow-50 text-yellow-700 text-xs font-medium">
                            <Phone className="w-3 h-3" />
                            Awaiting Code
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground">{getTimeSince(workflow.createdAt)}</span>
                    </div>

                    {/* Patient Info */}
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <User className="w-4 h-4 text-muted-foreground" />
                        <span className="font-medium text-foreground">
                          {workflow.patientData?.firstName} {workflow.patientData?.lastName}
                        </span>
                      </div>
                      
                      {workflow.currentStep && (
                        <div className="flex items-center gap-2">
                          <Clock className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm text-muted-foreground">{workflow.currentStep}</span>
                        </div>
                      )}

                      {workflow.confirmationNumber && (
                        <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded">
                          <span className="text-xs font-medium text-green-800">
                            Confirmation: {workflow.confirmationNumber}
                          </span>
                        </div>
                      )}

                      {workflow.errorMessage && (
                        <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded">
                          <span className="text-xs text-red-800">{workflow.errorMessage}</span>
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    {isActive && (
                      <div className="mt-3 pt-3 border-t border-border flex gap-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedWorkflow(workflow.id);
                          }}
                          className="flex items-center gap-1 px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 rounded transition-colors"
                        >
                          <Eye className="w-4 h-4" />
                          View
                        </button>
                        {workflow.manualOverrideEnabled ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleResumeWorkflow(workflow.id);
                            }}
                            className="flex items-center gap-1 px-3 py-1.5 text-sm text-green-600 hover:bg-green-50 rounded transition-colors"
                          >
                            <Play className="w-4 h-4" />
                            Resume
                          </button>
                        ) : (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handlePauseWorkflow(workflow.id);
                            }}
                            className="flex items-center gap-1 px-3 py-1.5 text-sm text-orange-600 hover:bg-orange-50 rounded transition-colors"
                          >
                            <Pause className="w-4 h-4" />
                            Pause
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleCancelWorkflow(workflow.id);
                          }}
                          className="flex items-center gap-1 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded transition-colors"
                        >
                          <XCircle className="w-4 h-4" />
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Details Panel */}
          <div className="lg:sticky lg:top-6 lg:self-start">
            {selectedWorkflowData ? (
              <div className="bg-white rounded-lg border-2 border-border overflow-hidden">
                <div className="p-4 bg-muted border-b border-border">
                  <h3 className="font-semibold text-foreground">Workflow Details</h3>
                  <p className="text-xs text-muted-foreground mt-1">ID: {selectedWorkflowData.id.substring(0, 8)}</p>
                </div>

                <div className="p-4 space-y-4 max-h-[calc(100vh-200px)] overflow-y-auto">
                  {/* Screenshots */}
                  {selectedWorkflowData.screenshots && selectedWorkflowData.screenshots.length > 0 && (
                    <div>
                      <h4 className="font-medium text-foreground mb-2">Latest Screenshot</h4>
                      <div className="space-y-2">
                        {selectedWorkflowData.screenshots.slice(-3).reverse().map((screenshot: string, idx: number) => (
                          <div key={idx} className="border border-border rounded overflow-hidden">
                            <img
                              src={screenshot}
                              alt={`Screenshot ${idx + 1}`}
                              className="w-full h-auto"
                            />
                            <div className="p-2 bg-muted text-xs text-muted-foreground">
                              Screenshot {selectedWorkflowData.screenshots.length - idx}/{selectedWorkflowData.screenshots.length}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Patient Data */}
                  <div>
                    <h4 className="font-medium text-foreground mb-2">Patient Information</h4>
                    <div className="bg-muted rounded p-3 text-sm space-y-1">
                      <div><span className="font-medium">Name:</span> {selectedWorkflowData.patientData?.firstName} {selectedWorkflowData.patientData?.lastName}</div>
                      <div><span className="font-medium">DOB:</span> {selectedWorkflowData.patientData?.dateOfBirth || 'Not provided'}</div>
                      <div><span className="font-medium">Phone:</span> {selectedWorkflowData.patientData?.phone || 'Not provided'}</div>
                      <div><span className="font-medium">Email:</span> {selectedWorkflowData.patientData?.email || 'Not provided'}</div>
                    </div>
                  </div>

                  {/* Form Progress */}
                  {selectedWorkflowData.formProgress && (
                    <div>
                      <h4 className="font-medium text-foreground mb-2">Form Progress</h4>
                      <div className="bg-muted rounded p-3 text-sm">
                        <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(selectedWorkflowData.formProgress, null, 2)}</pre>
                      </div>
                    </div>
                  )}

                  {/* Appointment Details */}
                  {selectedWorkflowData.appointmentDetails && (
                    <div>
                      <h4 className="font-medium text-foreground mb-2">Appointment Details</h4>
                      <div className="bg-green-50 border border-green-200 rounded p-3 text-sm space-y-1">
                        <div><span className="font-medium">Date:</span> {selectedWorkflowData.appointmentDetails.date}</div>
                        <div><span className="font-medium">Time:</span> {selectedWorkflowData.appointmentDetails.time}</div>
                        <div><span className="font-medium">Location:</span> {selectedWorkflowData.appointmentDetails.location}</div>
                      </div>
                    </div>
                  )}

                  {/* Timeline */}
                  <div>
                    <h4 className="font-medium text-foreground mb-2">Timeline</h4>
                    <div className="space-y-2 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Created:</span>
                        <span className="font-medium">{formatTimestamp(selectedWorkflowData.createdAt)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Last Updated:</span>
                        <span className="font-medium">{formatTimestamp(selectedWorkflowData.updatedAt)}</span>
                      </div>
                      {selectedWorkflowData.manualOverrideEnabled && (
                        <div className="p-2 bg-orange-50 border border-orange-200 rounded">
                          <span className="text-xs font-medium text-orange-800">⚠️ Manual Override Enabled</span>
                          {selectedWorkflowData.operatorNotes && (
                            <p className="text-xs text-orange-700 mt-1">{selectedWorkflowData.operatorNotes}</p>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-lg border-2 border-border p-12 text-center">
                <Eye className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                <p className="text-muted-foreground">Select a workflow to view details</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="text-center py-12 bg-white rounded-lg border-2 border-border">
          <Calendar className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
          <h3 className="text-lg font-medium text-foreground mb-2">No Workflows Found</h3>
          <p className="text-muted-foreground">
            {filter === 'active'
              ? 'No active scheduling sessions at the moment'
              : 'No scheduling workflows have been initiated yet'}
          </p>
        </div>
      )}
    </div>
  );
}
