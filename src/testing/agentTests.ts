import { testRunner } from './outboundTestRunner';

export interface AgentTestSuite {
  agentSlug: string;
  agentName: string;
  testScenarios: TestScenario[];
}

export interface TestScenario {
  name: string;
  description: string;
  phoneNumber: string;
  expectedBehavior: string;
  campaignId?: string;
  contactId?: string;
}

// Note: Test suites use phone number parameter passed at runtime
// Scenarios define expected behavior, not actual test data
export const AGENT_TEST_SUITES: AgentTestSuite[] = [
  {
    agentSlug: 'after-hours',
    agentName: 'After-Hours Triage Agent',
    testScenarios: [
      {
        name: 'Basic Triage Call',
        description: 'Test standard after-hours triage flow',
        phoneNumber: '', // Set at runtime
        expectedBehavior: 'Agent should greet caller, ask about symptoms, and determine urgency level'
      },
      {
        name: 'STAT Emergency Detection',
        description: 'Test human handoff for STAT conditions',
        phoneNumber: '', // Set at runtime
        expectedBehavior: 'Agent should detect emergency keywords and initiate human handoff'
      }
    ]
  },
  {
    agentSlug: 'drs-scheduler',
    agentName: 'DRS Outbound Scheduler',
    testScenarios: [
      {
        name: 'Outbound DRS Scheduling',
        description: 'Test diabetic retinopathy screening appointment scheduling',
        phoneNumber: '', // Set at runtime
        expectedBehavior: 'Agent should introduce DRS screening, ask about availability, and schedule appointment',
        campaignId: '', // Set at runtime
        contactId: '' // Set at runtime
      }
    ]
  },
  {
    agentSlug: 'appointment-confirmation',
    agentName: 'Appointment Confirmation Agent',
    testScenarios: [
      {
        name: 'Outbound Confirmation',
        description: 'Test appointment confirmation and reminder call',
        phoneNumber: '', // Set at runtime
        expectedBehavior: 'Agent should confirm upcoming appointment details and ask for confirmation'
      }
    ]
  },
  {
    agentSlug: 'answering-service',
    agentName: 'Answering Service Agent',
    testScenarios: [
      {
        name: 'Inbound Message Taking',
        description: 'Test answering service for Optical/Surgery/Clinical departments',
        phoneNumber: '', // Set at runtime
        expectedBehavior: 'Agent should identify department, take message, and create ticket'
      }
    ]
  }
];

export async function runAgentTest(
  agentSlug: string,
  phoneNumber: string,
  scenarioName?: string,
  campaignId?: string,
  contactId?: string
): Promise<any> {
  console.log('\n' + '='.repeat(80));
  console.log(`🧪 AGENT TEST: ${agentSlug.toUpperCase()}`);
  if (scenarioName) {
    console.log(`📋 Scenario: ${scenarioName}`);
  }
  console.log('='.repeat(80) + '\n');

  const result = await testRunner.makeTestCall({
    agentSlug,
    toPhoneNumber: phoneNumber,
    campaignId,
    contactId
  });

  console.log('\n' + '='.repeat(80));
  console.log('📊 TEST RESULTS');
  console.log('='.repeat(80));
  console.log(`Status: ${result.success ? '✅ SUCCESS' : '❌ FAILED'}`);
  console.log(`Duration: ${result.duration}ms`);
  if (result.callSid) {
    console.log(`Call SID: ${result.callSid}`);
  }
  if (result.error) {
    console.log(`Error: ${result.error}`);
  }
  console.log('\n📝 DETAILED LOGS:');
  console.log('-'.repeat(80));
  result.logs.forEach(log => console.log(log));
  console.log('='.repeat(80) + '\n');

  return result;
}

export async function runAllAgentTests(phoneNumber: string): Promise<void> {
  console.log('\n' + '='.repeat(80));
  console.log('🚀 RUNNING COMPREHENSIVE AGENT TEST SUITE');
  console.log('='.repeat(80) + '\n');

  for (const suite of AGENT_TEST_SUITES) {
    console.log(`\n${'*'.repeat(80)}`);
    console.log(`📦 Testing Agent: ${suite.agentName}`);
    console.log(`${'*'.repeat(80)}\n`);

    for (const scenario of suite.testScenarios) {
      await runAgentTest(suite.agentSlug, phoneNumber, scenario.name);
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log('✅ ALL TESTS COMPLETED');
  console.log('='.repeat(80) + '\n');
}

export async function testTwilioConnectivity(): Promise<void> {
  console.log('\n' + '='.repeat(80));
  console.log('🔌 TWILIO CONNECTIVITY TEST');
  console.log('='.repeat(80) + '\n');

  const result = await testRunner.testTwilioConnectivity();

  console.log('\n' + '='.repeat(80));
  console.log('📊 CONNECTIVITY TEST RESULTS');
  console.log('='.repeat(80));
  console.log(`Status: ${result.connected ? '✅ CONNECTED' : '❌ DISCONNECTED'}`);
  if (result.accountSid) {
    console.log(`Account SID: ${result.accountSid}`);
  }
  if (result.phoneNumber) {
    console.log(`Phone Number: ${result.phoneNumber}`);
  }
  if (result.error) {
    console.log(`Error: ${result.error}`);
  }
  console.log('='.repeat(80) + '\n');
}
