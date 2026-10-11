// essayWriter.js: drafts and revises scholarship essays with Claude from a
// student's profile and uploaded documents (routes/scholarships.js).
//
// The student's material (profile + files) goes first and carries a cache
// breakpoint, so several essays written in one sitting reuse it cheaply.

const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const mammoth = require('mammoth');

const MODEL = 'claude-opus-5-5';
const MAX_TEXT_CHARS = 60000; // per uploaded text/Word file

// The "About Me" form. Order here is the order on the page.
const PROFILE_FIELDS = [
  { key: 'basics', label: 'The basics', hint: 'Full name, high school or college, grade / graduation year, GPA, test scores, hometown.', rows: 4 },
  { key: 'plans', label: 'College plans & major', hint: 'Colleges applied to or attending, intended major, why that field.', rows: 3 },
  { key: 'goals', label: 'Career goals', hint: 'What you want to do after school, and why. Who or what got you interested.', rows: 3 },
  { key: 'activities', label: 'Activities & leadership', hint: 'Sports, clubs, music, student government. Roles, years, what you actually did.', rows: 5 },
  { key: 'work', label: 'Jobs & volunteering', hint: 'Where, how long, responsibilities, hours. Include working events with Dad if you have.', rows: 4 },
  { key: 'awards', label: 'Awards & honors', hint: 'Academic, athletic, community. Year for each.', rows: 3 },
  { key: 'stories', label: 'Stories & moments', hint: 'Specific moments that shaped you: a challenge you got through, a time you led, failed, helped someone, changed your mind. Details matter most here.', rows: 8 },
  { key: 'family', label: 'Family & background', hint: 'Family, heritage, hardships, first-generation status, anything financial a need-based scholarship should know. Only what you are comfortable sharing.', rows: 4 },
  { key: 'values', label: 'What matters to you', hint: 'Values, causes, faith, community. What people would say about you.', rows: 3 },
  { key: 'voice', label: 'How you write & talk', hint: 'Describe your style (funny? straightforward? low-key?), words you would never use, or paste something you wrote.', rows: 4 },
  { key: 'other', label: 'Anything else', hint: 'Hobbies, interests, things that make you you.', rows: 3 },
];

const SYSTEM_PROMPT = `You help a student write scholarship application essays. You get the student's profile and documents (resume, transcript, past essays, certificates, and so on), the scholarship's prompt, and sometimes an angle the student wants. You write an essay the student will read, edit, and submit as their own.

Write in the student's voice: a real teenager or young adult, specific and sincere, not polished marketing copy. Match the tone of anything they've written themselves. Plain words beat impressive ones. Avoid scholarship-essay clichés ("ever since I was young", "I have always been passionate about", "in today's society", "this experience taught me"), and don't open with a dictionary definition or a quote.

Build the essay around one or two concrete stories or details from the material that actually answer the prompt. Show rather than list. A short essay should focus on one thing. Connect to the scholarship's mission or sponsor where the prompt invites it.

Use only facts from the material. Never invent experiences, numbers, names, awards or feelings. If the essay needs a detail the material doesn't have, put a short placeholder in square brackets, like [name of coach] or [what you said to her], and mention it in the notes.

Respect the word limit: aim for 90-100% of it and never go over. With no limit given, write about 500 words.

Return the essay text with paragraphs separated by blank lines, and no title unless the prompt asks for one. In notes, write a few short lines to the student: what you focused on and why, any [placeholders] to fill in, and facts to double-check.`;

const ESSAY_SCHEMA = {
  type: 'object',
  properties: {
    essay: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['essay', 'notes'],
  additionalProperties: false,
};

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw Object.assign(new Error('ANTHROPIC_API_KEY is not set'), { userMessage: 'The essay writer is not configured on the server yet.' });
  }
  if (!client) client = new Anthropic();
  return client;
}

function wordCount(text) {
  return (String(text || '').match(/\S+/g) || []).length;
}

// One uploaded file -> Claude content blocks.
async function fileBlocks(f) {
  const label = `Uploaded file: ${f.original_name}${f.description ? ` (${f.description})` : ''}`;
  try {
    if (f.mime === 'application/pdf') {
      return [{ type: 'text', text: label }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(f.path).toString('base64') } }];
    }
    if (f.mime.startsWith('image/')) {
      return [{ type: 'text', text: label }, { type: 'image', source: { type: 'base64', media_type: f.mime, data: fs.readFileSync(f.path).toString('base64') } }];
    }
    let text;
    if (f.mime.includes('wordprocessingml')) text = (await mammoth.extractRawText({ path: f.path })).value;
    else text = fs.readFileSync(f.path, 'utf8');
    return [{ type: 'text', text: `${label}\n\n${text.slice(0, MAX_TEXT_CHARS)}` }];
  } catch (err) {
    console.error(`Could not read ${f.original_name}:`, err.message);
    return [{ type: 'text', text: `${label}: could not be read.` }];
  }
}

function profileText(studentName, profile) {
  const parts = PROFILE_FIELDS
    .filter(f => String(profile[f.key] || '').trim())
    .map(f => `## ${f.label}\n${String(profile[f.key]).trim()}`);
  return `# Student: ${studentName}\n\n${parts.join('\n\n') || '(The profile is empty so far.)'}`;
}

function taskText(essay, revision) {
  const lines = [
    `Scholarship: ${essay.scholarship}`,
    `Essay prompt:\n${essay.prompt}`,
    `Word limit: ${essay.word_limit ? essay.word_limit + ' words' : 'none given'}`,
  ];
  if (essay.angle) lines.push(`What the student wants to focus on:\n${essay.angle}`);
  if (revision) {
    lines.push(`Current version of the essay:\n"""\n${revision.text}\n"""`);
    lines.push(`Revise it as follows, keeping what works and staying within the word limit:\n${revision.instruction}`);
  } else {
    lines.push('Write the essay.');
  }
  return lines.join('\n\n');
}

// -> { essay, notes }
async function writeEssay({ studentName, profile, files, essay, revision }) {
  const anthropic = getClient();
  const material = [{ type: 'text', text: profileText(studentName, profile) }];
  for (const f of files) material.push(...await fileBlocks(f));
  material[material.length - 1].cache_control = { type: 'ephemeral' };

  const stream = anthropic.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [...material, { type: 'text', text: taskText(essay, revision) }] }],
    output_config: { effort: 'high', format: { type: 'json_schema', schema: ESSAY_SCHEMA } },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  });
  const response = await stream.finalMessage();

  if (response.stop_reason === 'refusal') {
    throw Object.assign(new Error('refusal'), { userMessage: 'Claude declined to write this one. Try rewording the prompt or focus.' });
  }
  if (response.stop_reason === 'max_tokens') {
    throw Object.assign(new Error('max_tokens'), { userMessage: 'The draft was cut off. Click Retry.' });
  }
  const text = response.content.find(b => b.type === 'text');
  if (!text) throw Object.assign(new Error('no text block'), { userMessage: 'The draft came back empty. Click Retry.' });
  const out = JSON.parse(text.text);
  return { essay: String(out.essay || '').trim(), notes: String(out.notes || '').trim() };
}

module.exports = { writeEssay, wordCount, PROFILE_FIELDS };
