import Twilio from 'twilio';

async function testDelivery() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER || '+19093108277';
  const toNumber = process.env.HUMAN_AGENT_NUMBER || '+18455317471';

  if (!accountSid || !authToken) {
    console.error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
    process.exit(1);
  }

  const client = Twilio(accountSid, authToken);
  
  console.log(`Testing delivery from ${fromNumber} to ${toNumber}`);
  console.log('='.repeat(50));

  // Test 1: Check if fromNumber is a valid Twilio number
  console.log('\n[TEST 1] Checking if from number is a valid Twilio number...');
  try {
    const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: fromNumber });
    if (numbers.length > 0) {
      const num = numbers[0];
      console.log(`  ✓ ${fromNumber} is a valid Twilio number`);
      console.log(`  Friendly name: ${num.friendlyName}`);
      console.log(`  SMS capable: ${num.capabilities?.sms}`);
      console.log(`  Voice capable: ${num.capabilities?.voice}`);
    } else {
      console.error(`  ✗ ${fromNumber} is NOT found in Twilio account!`);
    }
  } catch (err: any) {
    console.error(`  ✗ Error checking number: ${err.message}`);
  }

  // Test 2: Send a test SMS
  console.log('\n[TEST 2] Sending test SMS...');
  try {
    const msg = await client.messages.create({
      body: `[TEST] Handoff delivery test at ${new Date().toISOString()}`,
      from: fromNumber,
      to: toNumber,
    });
    console.log(`  ✓ SMS sent: SID=${msg.sid}, Status=${msg.status}`);
    
    // Check status after 3 seconds
    await new Promise(r => setTimeout(r, 3000));
    const updated = await client.messages(msg.sid).fetch();
    console.log(`  Status after 3s: ${updated.status}`);
    if (updated.errorCode) {
      console.error(`  ✗ Error code: ${updated.errorCode} - ${updated.errorMessage}`);
    }
  } catch (err: any) {
    console.error(`  ✗ SMS FAILED: ${err.message}`);
    if (err.code) console.error(`  Error code: ${err.code}`);
  }

  // Test 3: Check recent outbound calls to this number
  console.log('\n[TEST 3] Recent outbound calls to human agent number...');
  try {
    const calls = await client.calls.list({
      to: toNumber,
      limit: 5,
    });
    for (const call of calls) {
      console.log(`  ${call.dateCreated?.toISOString()} | ${call.from} → ${call.to} | ${call.status} | ${call.duration}s | AnsweredBy: ${call.answeredBy || 'n/a'}`);
    }
    if (calls.length === 0) {
      console.log('  No recent outbound calls found');
    }
  } catch (err: any) {
    console.error(`  ✗ Error listing calls: ${err.message}`);
  }

  // Test 4: Check A2P messaging registration
  console.log('\n[TEST 4] Checking messaging service configuration...');
  try {
    const services = await client.messaging.v1.services.list({ limit: 5 });
    if (services.length > 0) {
      for (const svc of services) {
        console.log(`  Service: ${svc.friendlyName} (${svc.sid})`);
      }
    } else {
      console.log('  No messaging services configured');
      console.log('  ⚠️ SMS from long codes may be filtered without A2P registration');
    }
  } catch (err: any) {
    console.log(`  Could not check messaging services: ${err.message}`);
  }

  console.log('\n' + '='.repeat(50));
  console.log('Test complete. Check your phone for the test SMS.');
}

testDelivery().catch(console.error);
