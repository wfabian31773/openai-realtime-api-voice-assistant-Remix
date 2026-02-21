import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export interface CallReviewResult {
  overallAssessment: string;
  conversationFlowIssues: {
    issue: string;
    timestamp?: string;
    severity: 'minor' | 'moderate' | 'major';
    suggestion: string;
  }[];
  promptImprovements: {
    area: string;
    currentBehavior: string;
    suggestedChange: string;
    expectedImpact: string;
  }[];
  positives: string[];
  naturalness: number;
  efficiency: number;
  patientExperience: number;
}

export async function reviewCallForPromptImprovement(
  transcript: string,
  agentSlug: string,
  ivrSelection?: string
): Promise<CallReviewResult> {
  const contextInfo = ivrSelection 
    ? `IVR Selection: Option ${ivrSelection} (${getIvrContext(ivrSelection)})`
    : 'Unknown IVR context';

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are an expert conversation analyst specializing in medical call center AI agents. Your job is to analyze call transcripts and provide actionable feedback to improve the agent's prompts and conversation flow.

Focus on:
1. CONVERSATION FLOW - Was the pacing natural? Did the agent interrupt? Was there awkward pauses or rushing?
2. TURN-TAKING - Did the agent wait for the caller to finish speaking? Did it acknowledge what they said?
3. INFORMATION GATHERING - Was it efficient? Did it ask redundant questions? Did it miss opportunities to use context?
4. EMPATHY & TONE - Did the agent sound caring without being scripted? Was it appropriate for a medical context?
5. DATA ACCURACY - Did it capture information correctly? Did it confirm important details?
6. PROMPT IMPROVEMENTS - What specific changes to the system prompt would improve future calls?

Return a JSON object with this exact structure:
{
  "overallAssessment": "2-3 sentence summary of the call quality and key areas for improvement",
  "conversationFlowIssues": [
    {
      "issue": "Description of the issue",
      "timestamp": "Approximate point in conversation if identifiable",
      "severity": "minor|moderate|major",
      "suggestion": "How to fix this in the prompt or agent behavior"
    }
  ],
  "promptImprovements": [
    {
      "area": "Category (e.g., 'Opening Flow', 'Data Collection', 'Triage Logic')",
      "currentBehavior": "What the agent is currently doing",
      "suggestedChange": "Specific prompt text or instruction to add/modify",
      "expectedImpact": "How this will improve calls"
    }
  ],
  "positives": ["Things the agent did well"],
  "naturalness": 1-10,
  "efficiency": 1-10,
  "patientExperience": 1-10
}`
      },
      {
        role: 'user',
        content: `Analyze this call transcript from the "${agentSlug}" agent.
${contextInfo}

TRANSCRIPT:
${transcript}

Provide detailed feedback focusing on conversation flow issues and specific prompt improvements.`
      }
    ]
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('No response from OpenAI');
  }

  try {
    const result = JSON.parse(content) as CallReviewResult;
    return result;
  } catch (e) {
    console.error('[CALL REVIEW] Failed to parse response:', content);
    throw new Error('Failed to parse AI review response');
  }
}

function getIvrContext(selection: string): string {
  switch (selection) {
    case '1': return 'Non-Urgent Request';
    case '2': return 'Urgent Triage';
    case '3': return 'Provider Line';
    case '4': return 'Spanish';
    default: return 'Unknown';
  }
}

export async function reviewMultipleCallsForPatterns(
  calls: { transcript: string; agentSlug: string; qualityScore?: number }[]
): Promise<{
  patterns: { pattern: string; frequency: number; impact: string }[];
  topPriorityImprovements: { improvement: string; affectedCalls: number; effort: string }[];
  summary: string;
}> {
  const transcriptSummaries = calls.map((c, i) => 
    `--- Call ${i + 1} (Agent: ${c.agentSlug}, Quality: ${c.qualityScore || 'N/A'}) ---\n${c.transcript.slice(0, 1500)}...`
  ).join('\n\n');

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `You are a conversation analyst identifying patterns across multiple AI call center calls. Identify recurring issues and prioritize improvements.

Return JSON:
{
  "patterns": [
    { "pattern": "Description", "frequency": number_of_calls_affected, "impact": "How it affects patient experience" }
  ],
  "topPriorityImprovements": [
    { "improvement": "Specific change", "affectedCalls": number, "effort": "low|medium|high" }
  ],
  "summary": "Overall analysis summary"
}`
      },
      {
        role: 'user',
        content: `Analyze these ${calls.length} call transcripts for patterns:\n\n${transcriptSummaries}`
      }
    ]
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error('No response from OpenAI');
  }

  return JSON.parse(content);
}

export const callReviewService = {
  reviewCallForPromptImprovement,
  reviewMultipleCallsForPatterns
};
