import { useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { BookOpen, Phone, PhoneIncoming, PhoneOutgoing, AlertCircle, CheckCircle, ExternalLink } from 'lucide-react'
import { formatPhoneNumber } from '@/lib/phoneFormat'

export function DocumentationPage() {
  const [activeSection, setActiveSection] = useState('overview')

  const sections = [
    { id: 'overview', title: 'Overview', icon: BookOpen },
    { id: 'agent-types', title: 'Agent Types', icon: Phone },
    { id: 'assignment', title: 'Phone Number Assignment', icon: PhoneIncoming },
    { id: 'inbound', title: 'Inbound Call Routing', icon: PhoneIncoming },
    { id: 'outbound', title: 'Outbound Caller ID', icon: PhoneOutgoing },
    { id: 'howto', title: 'How to Assign Numbers', icon: CheckCircle },
    { id: 'twilio', title: 'Twilio Configuration', icon: AlertCircle },
    { id: 'troubleshooting', title: 'Troubleshooting', icon: AlertCircle },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Documentation</h1>
          <p className="text-muted-foreground">Agent configuration and phone number management guide</p>
        </div>
        <a 
          href="https://www.twilio.com/docs/voice" 
          target="_blank" 
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm text-primary hover:text-blue-700"
        >
          <ExternalLink className="h-4 w-4" />
          Twilio Docs
        </a>
      </div>

      <div className="grid gap-6 lg:grid-cols-4">
        {/* Table of Contents */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Contents</CardTitle>
          </CardHeader>
          <CardContent>
            <nav className="space-y-1">
              {sections.map((section) => (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                    activeSection === section.id
                      ? 'bg-primary/10 text-blue-700 font-medium'
                      : 'text-foreground hover:bg-muted'
                  }`}
                >
                  <section.icon className="h-4 w-4" />
                  {section.title}
                </button>
              ))}
            </nav>
          </CardContent>
        </Card>

        {/* Content Area */}
        <div className="lg:col-span-3 space-y-6">
          {/* Overview */}
          {activeSection === 'overview' && (
            <Card>
              <CardHeader>
                <CardTitle>Overview</CardTitle>
              </CardHeader>
              <CardContent className="prose prose-sm max-w-none">
                <p>
                  This guide explains how Twilio phone numbers are assigned to AI voice agents in the Azul Vision AI Operations Hub. 
                  Understanding the relationship between agents and phone numbers is critical for proper configuration and operation.
                </p>
                <div className="mt-4 p-4 bg-primary/10 border border-blue-200 rounded-lg">
                  <h4 className="text-sm font-semibold text-blue-900 mb-2">Key Concepts</h4>
                  <ul className="text-sm text-blue-800 space-y-1 mb-0">
                    <li>Each agent has a <strong>type</strong> (inbound or outbound)</li>
                    <li>Phone numbers can be assigned to agents for routing or caller ID</li>
                    <li>Inbound agents receive calls; outbound agents make calls</li>
                    <li>Twilio webhook configuration is required for inbound agents</li>
                  </ul>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Agent Types */}
          {activeSection === 'agent-types' && (
            <Card>
              <CardHeader>
                <CardTitle>Understanding Agent Types</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="border border-blue-200 rounded-lg p-4 bg-primary/10">
                  <div className="flex items-center gap-2 mb-2">
                    <PhoneIncoming className="h-5 w-5 text-primary" />
                    <h3 className="font-semibold text-blue-900">Inbound Agents</h3>
                  </div>
                  <ul className="text-sm text-blue-800 space-y-1">
                    <li><strong>Purpose:</strong> Receive and handle incoming calls</li>
                    <li><strong>Examples:</strong> After-Hours Triage, Answering Service</li>
                    <li><strong>Phone Number Usage:</strong> Calls <strong>to</strong> the assigned number are routed <strong>to</strong> this agent</li>
                    <li><strong>Configuration:</strong> Requires Twilio webhook configuration to route incoming calls</li>
                  </ul>
                </div>

                <div className="border border-green-200 rounded-lg p-4 bg-green-50">
                  <div className="flex items-center gap-2 mb-2">
                    <PhoneOutgoing className="h-5 w-5 text-green-600" />
                    <h3 className="font-semibold text-green-900">Outbound Agents</h3>
                  </div>
                  <ul className="text-sm text-green-800 space-y-1">
                    <li><strong>Purpose:</strong> Make outgoing calls to patients/contacts</li>
                    <li><strong>Examples:</strong> DRS Outbound Scheduler, Appointment Confirmation</li>
                    <li><strong>Phone Number Usage:</strong> Calls <strong>from</strong> this agent display the assigned number as <strong>caller ID</strong></li>
                    <li><strong>Configuration:</strong> Uses Twilio's Programmable Voice API to initiate calls</li>
                  </ul>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Phone Number Assignment */}
          {activeSection === 'assignment' && (
            <Card>
              <CardHeader>
                <CardTitle>Phone Number Assignment</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold mb-2">Viewing Current Assignments</h3>
                  <p className="text-sm text-muted-foreground mb-3">
                    To view which phone numbers are assigned to which agents, navigate to the <strong>Agents</strong> page. 
                    Each agent card displays:
                  </p>
                  <ul className="text-sm text-foreground space-y-2 ml-4">
                    <li className="flex items-start gap-2">
                      <Phone className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <span><strong>Phone number</strong> (if assigned) with E.164 formatting</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <PhoneIncoming className="h-4 w-4 text-primary mt-0.5" />
                      <span><strong>Inbound icon</strong> (blue) for agents receiving calls</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <PhoneOutgoing className="h-4 w-4 text-green-600 mt-0.5" />
                      <span><strong>Outbound icon</strong> (green) for agents making calls</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5" />
                      <span><strong>Warning</strong> if no phone number is assigned</span>
                    </li>
                  </ul>
                </div>

                <div className="bg-muted border border-border rounded-lg p-4">
                  <h4 className="text-sm font-semibold mb-2">Example Configurations</h4>
                  <div className="space-y-3">
                    <div className="text-sm">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline">Inbound</Badge>
                        <span className="font-medium">After-Hours Triage</span>
                      </div>
                      <div className="text-muted-foreground">
                        Phone: <code className="bg-white px-1 rounded">{formatPhoneNumber('+16265550100')}</code><br />
                        <span className="text-xs">✅ Patients calling this number reach the After-Hours Triage agent</span>
                      </div>
                    </div>
                    <div className="text-sm">
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline">Outbound</Badge>
                        <span className="font-medium">DRS Outbound Scheduler</span>
                      </div>
                      <div className="text-muted-foreground">
                        Phone: <code className="bg-white px-1 rounded">{formatPhoneNumber('+16265550200')}</code><br />
                        <span className="text-xs">✅ Patients see this number as caller ID when agent calls them</span>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Inbound Routing */}
          {activeSection === 'inbound' && (
            <Card>
              <CardHeader>
                <CardTitle>Inbound Call Routing</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold mb-2">How Inbound Routing Works</h3>
                  <ol className="text-sm text-foreground space-y-2 ml-4 list-decimal">
                    <li><strong>Patient calls</strong> a Twilio phone number (e.g., +1-626-555-0100)</li>
                    <li><strong>Twilio receives</strong> the call and checks webhook configuration</li>
                    <li><strong>Webhook routes</strong> the call to the Voice Agent Server (port 8000)</li>
                    <li><strong>Server looks up</strong> which agent is assigned to that phone number</li>
                    <li><strong>Agent answers</strong> and begins conversation using OpenAI Realtime API</li>
                  </ol>
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-amber-900 mb-2">⚠️ Required Twilio Configuration</h4>
                  <p className="text-sm text-amber-800 mb-3">
                    For inbound agents to work, you must configure the Twilio phone number webhook:
                  </p>
                  <div className="bg-white border border-amber-300 rounded p-3 text-sm">
                    <div className="font-medium mb-1">Webhook URL:</div>
                    <code className="text-xs bg-muted px-2 py-1 rounded block">
                      https://your-replit-domain.repl.co:8000/api/voice/inbound
                    </code>
                  </div>
                  <div className="mt-3 text-xs text-amber-800">
                    <strong>Configuration Steps (Twilio Console):</strong>
                    <ol className="ml-4 mt-1 space-y-1 list-decimal">
                      <li>Log in to Twilio Console</li>
                      <li>Navigate to <strong>Phone Numbers → Manage → Active numbers</strong></li>
                      <li>Click on the phone number you want to configure</li>
                      <li>Scroll to <strong>Voice Configuration</strong></li>
                      <li>Set <strong>A Call Comes In</strong> to Webhook (POST)</li>
                      <li>Click <strong>Save</strong></li>
                    </ol>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Outbound Caller ID */}
          {activeSection === 'outbound' && (
            <Card>
              <CardHeader>
                <CardTitle>Outbound Caller ID</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold mb-2">How Outbound Caller ID Works</h3>
                  <ol className="text-sm text-foreground space-y-2 ml-4 list-decimal">
                    <li><strong>Campaign triggers</strong> outbound call (e.g., DRS screening campaign)</li>
                    <li><strong>Server initiates call</strong> via Twilio API with specified "From" number</li>
                    <li><strong>Twilio places call</strong> using the assigned phone number as caller ID</li>
                    <li><strong>Patient's phone</strong> displays the configured Twilio number</li>
                    <li><strong>Agent converses</strong> with patient using OpenAI Realtime API</li>
                  </ol>
                </div>

                <div className="bg-green-50 border border-green-200 rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-green-900 mb-2">✅ Best Practices</h4>
                  <ul className="text-sm text-green-800 space-y-1">
                    <li>✅ Use a <strong>local area code</strong> matching your practice location</li>
                    <li>✅ Use a <strong>consistent number</strong> across campaigns (builds trust)</li>
                    <li>✅ Ensure the number is <strong>configured in Twilio</strong> and verified</li>
                    <li>⚠️ <strong>Never use</strong> personal cell phones or unverified numbers</li>
                  </ul>
                </div>

                <div className="bg-muted border border-border rounded-lg p-4">
                  <h4 className="text-sm font-semibold mb-2">Example Configuration</h4>
                  <div className="text-sm text-foreground space-y-1">
                    <div><strong>Practice Location:</strong> Pasadena, CA (626 area code)</div>
                    <div><strong>Outbound Number:</strong> <code className="bg-white px-1 rounded">{formatPhoneNumber('+16265550200')}</code></div>
                    <div><strong>Caller ID Display:</strong> "AZUL VISION" (configured in Twilio)</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* How to Assign */}
          {activeSection === 'howto' && (
            <Card>
              <CardHeader>
                <CardTitle>How to Assign Phone Numbers</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold mb-2">Method 1: During Agent Creation</h3>
                  <ol className="text-sm text-foreground space-y-2 ml-4 list-decimal">
                    <li>Navigate to <strong>Agents</strong> page</li>
                    <li>Click <strong>Create Agent</strong></li>
                    <li>Fill in agent details (name, type, prompts)</li>
                    <li>In <strong>Twilio Phone Number</strong> dropdown, select from available numbers</li>
                    <li>Click <strong>Create Agent</strong></li>
                  </ol>
                </div>

                <div>
                  <h3 className="text-sm font-semibold mb-2">Method 2: Edit Existing Agent</h3>
                  <ol className="text-sm text-foreground space-y-2 ml-4 list-decimal">
                    <li>Navigate to <strong>Agents</strong> page</li>
                    <li>Find the agent you want to configure</li>
                    <li>Click <strong>Configure</strong> button</li>
                    <li>Select or change <strong>Twilio Phone Number</strong></li>
                    <li>Click <strong>Save Changes</strong></li>
                  </ol>
                </div>

                <div>
                  <h3 className="text-sm font-semibold mb-2">Method 3: Clear Phone Number Assignment</h3>
                  <p className="text-sm text-muted-foreground mb-2">To unassign a phone number from an agent:</p>
                  <ol className="text-sm text-foreground space-y-2 ml-4 list-decimal">
                    <li>Click <strong>Configure</strong> on the agent card</li>
                    <li>Set <strong>Twilio Phone Number</strong> to "-- No phone number assigned --"</li>
                    <li>Click <strong>Save Changes</strong></li>
                  </ol>
                  <p className="text-sm text-muted-foreground mt-2">The phone number becomes available for other agents.</p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Twilio Configuration */}
          {activeSection === 'twilio' && (
            <Card>
              <CardHeader>
                <CardTitle>Twilio Configuration Requirements</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold mb-2">Prerequisites</h3>
                  <p className="text-sm text-muted-foreground mb-3">
                    Before assigning phone numbers to agents, ensure you have:
                  </p>
                  <div className="space-y-3">
                    <div className="flex items-start gap-2">
                      <CheckCircle className="h-4 w-4 text-green-600 mt-0.5" />
                      <div className="text-sm">
                        <strong>Active Twilio Account</strong> with verified phone numbers, sufficient credit, and SIP Trunking enabled
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <CheckCircle className="h-4 w-4 text-green-600 mt-0.5" />
                      <div className="text-sm">
                        <strong>Phone Numbers Configured</strong> with voice capability, webhooks (for inbound), and caller ID verification
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <CheckCircle className="h-4 w-4 text-green-600 mt-0.5" />
                      <div className="text-sm">
                        <strong>Environment Variables Set:</strong> TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-primary/10 border border-blue-200 rounded-lg p-4">
                  <h4 className="text-sm font-semibold text-blue-900 mb-2">Fetching Available Phone Numbers</h4>
                  <p className="text-sm text-blue-800">
                    The system automatically fetches available Twilio numbers via the API endpoint:
                  </p>
                  <code className="text-xs bg-white px-2 py-1 rounded block mt-2">
                    GET /twilio/phone-numbers
                  </code>
                  <p className="text-xs text-blue-800 mt-2">
                    This returns phone numbers owned by your Twilio account, friendly names, and capabilities (voice, SMS).
                  </p>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Troubleshooting */}
          {activeSection === 'troubleshooting' && (
            <Card>
              <CardHeader>
                <CardTitle>Troubleshooting</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="border-l-4 border-red-500 bg-red-50 p-4">
                  <h4 className="text-sm font-semibold text-red-900 mb-2">Problem: Inbound calls not reaching agent</h4>
                  <div className="text-sm text-red-800 space-y-2">
                    <div>
                      <strong>Possible Causes:</strong>
                      <ul className="ml-4 mt-1 space-y-1">
                        <li>❌ Twilio webhook not configured</li>
                        <li>❌ Wrong webhook URL</li>
                        <li>❌ Phone number not assigned to agent in database</li>
                      </ul>
                    </div>
                    <div>
                      <strong>Solution:</strong>
                      <ol className="ml-4 mt-1 space-y-1 list-decimal">
                        <li>Check Twilio Console → Phone Numbers → Voice Configuration</li>
                        <li>Verify webhook URL matches Voice Agent Server endpoint</li>
                        <li>Check Agents page to confirm phone number assignment</li>
                        <li>Review Voice Agent Server logs for incoming call events</li>
                      </ol>
                    </div>
                  </div>
                </div>

                <div className="border-l-4 border-amber-500 bg-amber-50 p-4">
                  <h4 className="text-sm font-semibold text-amber-900 mb-2">Problem: Outbound calls showing wrong caller ID</h4>
                  <div className="text-sm text-amber-800 space-y-2">
                    <div>
                      <strong>Possible Causes:</strong>
                      <ul className="ml-4 mt-1 space-y-1">
                        <li>❌ Agent has no phone number assigned</li>
                        <li>❌ Campaign using default fallback number</li>
                        <li>❌ Twilio number not verified</li>
                      </ul>
                    </div>
                    <div>
                      <strong>Solution:</strong>
                      <ol className="ml-4 mt-1 space-y-1 list-decimal">
                        <li>Navigate to Agents page</li>
                        <li>Configure correct phone number for outbound agent</li>
                        <li>Verify number in Twilio Console</li>
                        <li>Check campaign configuration uses agent's assigned number</li>
                      </ol>
                    </div>
                  </div>
                </div>

                <div className="border-l-4 border-blue-500 bg-primary/10 p-4">
                  <h4 className="text-sm font-semibold text-blue-900 mb-2">Problem: "No phone number assigned" warning</h4>
                  <div className="text-sm text-blue-800 space-y-2">
                    <div>
                      <strong>This is expected if:</strong>
                      <ul className="ml-4 mt-1 space-y-1">
                        <li>✅ Agent is newly created and not yet configured</li>
                        <li>✅ Agent is for testing purposes only</li>
                        <li>✅ Agent is inactive/deprecated</li>
                      </ul>
                    </div>
                    <div>
                      <strong>Action Required:</strong>
                      <ul className="ml-4 mt-1 space-y-1">
                        <li>Configure a phone number if agent should handle calls</li>
                        <li>Leave unassigned if agent is not yet deployed</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Quick Reference Footer */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Reference</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <h4 className="text-sm font-semibold mb-2">Phone Number Flow</h4>
              <div className="text-sm space-y-2 text-foreground">
                <div>
                  <strong>Inbound:</strong><br />
                  <code className="text-xs bg-muted px-1 rounded">
                    Patient dials → Twilio → Webhook → Voice Server → Agent (lookup)
                  </code>
                </div>
                <div>
                  <strong>Outbound:</strong><br />
                  <code className="text-xs bg-muted px-1 rounded">
                    Campaign → Voice Server → Twilio (From number) → Patient sees caller ID
                  </code>
                </div>
              </div>
            </div>
            <div>
              <h4 className="text-sm font-semibold mb-2">Key Pages</h4>
              <ul className="text-sm space-y-1 text-foreground">
                <li><strong>Agent Configuration:</strong> /agents</li>
                <li><strong>Twilio Console:</strong> console.twilio.com</li>
                <li><strong>Voice Agent Server:</strong> Port 8000</li>
                <li><strong>API Server:</strong> Port 5000</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
