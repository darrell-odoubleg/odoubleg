const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');

const MODEL = 'claude-opus-5-5';
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_TEXT_CHARS = 400000;

// ---------- schemas (structured outputs: every key required, no extras) ----------

const str = { type: 'string' };
const level = { type: 'string', enum: ['high', 'medium', 'low'] };
const obj = (props) => ({
  type: 'object',
  properties: props,
  required: Object.keys(props),
  additionalProperties: false,
});
const list = (items) => ({ type: 'array', items });

const DOC_SCHEMA = obj({
  document_type: str,          // e.g. "Sleep study (PSG)", "VA C&P exam", "Primary care visit"
  document_date: str,          // as written, or "" if none
  provider_or_facility: str,
  summary: str,
  sleep_apnea: obj({
    relevance: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    assessment: str,
    key_metrics: list(obj({ name: str, value: str, interpretation: str })),
    findings: list(obj({ item: str, detail: str, quote: str, location: str, significance: level })),
  }),
  va_disability: obj({
    relevance: { type: 'string', enum: ['high', 'medium', 'low', 'none'] },
    assessment: str,
    findings: list(obj({ category: str, item: str, detail: str, quote: str, location: str, why_it_matters: str, significance: level })),
    possible_claims: list(obj({ condition: str, diagnostic_code: str, evidence_in_document: str, service_connection_angle: str })),
  }),
  follow_up_questions: list(str),
});

const SUMMARY_SCHEMA = obj({
  overview: str,
  sleep_apnea: obj({
    status: str,
    strongest_evidence: list(str),
    gaps: list(str),
  }),
  va_disability: obj({
    strongest_evidence: list(str),
    possible_claims: list(obj({ condition: str, diagnostic_code: str, supporting_documents: str, service_connection_angle: str, missing_pieces: str })),
    gaps: list(str),
  }),
  timeline: list(obj({ date: str, event: str, document: str })),
  next_steps: list(str),
});

const SYSTEM = `You review a veteran's medical records for him. He wants two things from each document:

1. SLEEP APNEA: anything that points toward, confirms, rules out, or bears on obstructive/central sleep apnea. Look for: sleep study results (PSG, home sleep test) with AHI, RDI, ODI, oxygen nadir/SpO2, time below 88/90%; diagnoses (G47.33, G47.31, G47.30, 327.23); CPAP/BiPAP/APAP prescriptions, settings and compliance data; snoring, witnessed apneas, gasping/choking at night, non-restorative sleep, daytime sleepiness, Epworth (ESS) or STOP-BANG scores, morning headaches, nocturia; risk factors and linked conditions (BMI/obesity, neck circumference, Mallampati, hypertension, atrial fibrillation, diabetes, GERD, deviated septum, rhinitis); medications that affect sleep or breathing (opioids, benzodiazepines, sedatives). Also note anything that would cut against sleep apnea.

2. VA DISABILITY: anything useful for a VA disability claim, for sleep apnea or any other condition. Look for: diagnoses and their ICD codes; in-service events, injuries, exposures (burn pits, Agent Orange, Gulf War, PACT Act presumptives, noise, toxic exposure); deployments and dates of service; continuity of symptoms since service; nexus/medical opinion language ("at least as likely as not", "more likely than not", "caused by", "aggravated by"); secondary service connection paths (e.g. PTSD/mental health medications, weight gain from a service-connected condition, rhinitis/sinusitis, or tinnitus leading to or worsening sleep apnea; sleep apnea worsening hypertension); C&P exam findings, DBQ items, existing ratings and diagnostic codes, functional impact on work and daily life; anything that would hurt a claim (e.g. "less likely than not", pre-existing condition, gaps in treatment).

Rules:
- Only report what the document actually says. Put a short verbatim quote in "quote" for every finding, and say where it is in "location" (page, section, or "" if unclear).
- Mark significance high only for items that would matter to a sleep specialist or a VA rater.
- For diagnostic codes, give the VA diagnostic code (e.g. 6847 for sleep apnea syndromes) or ICD code when you are confident; otherwise "". Do not state a rating percentage unless the document states one: rating criteria change.
- "assessment" is 2–4 plain-English sentences for a non-medical reader.
- If the document has nothing relevant for a section, set relevance to "none" and leave the lists empty.
- follow_up_questions: concrete things worth asking a doctor or a VSO about, based on this document. Up to 5.
- This is not medical or legal advice; don't pad the output with disclaimers, the page already shows one.`;

// ---------- helpers ----------

function pdfToText(file) {
  return new Promise((resolve, reject) => {
    execFile('pdftotext', ['-layout', file, '-'], { maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      if (err) return reject(err);
      resolve(out);
    });
  });
}

async function callClaude(content, schema, system) {
  // Streamed only so the SDK allows a large max_tokens; we just wait for the final message.
  const resp = await client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content }],
  }).finalMessage();
  if (resp.stop_reason === 'refusal') throw new Error('The model declined to analyze this document.');
  if (resp.stop_reason === 'max_tokens') throw new Error('The analysis ran too long — try splitting the document.');
  const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}

async function documentBlocks(doc) {
  const file = path.join(UPLOAD_DIR, doc.stored_name);
  const intro = { type: 'text', text: `File name: ${doc.original_name}\n\nReview this document as instructed.` };
  if (doc.mime === 'application/pdf') {
    const data = fs.readFileSync(file).toString('base64');
    return {
      primary: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }, intro],
      // Very long or odd PDFs can be rejected as a document block; their text layer usually still works.
      fallback: async () => {
        const text = (await pdfToText(file)).slice(0, MAX_TEXT_CHARS);
        if (!text.trim()) throw new Error('This PDF has no readable text and could not be read as a document. Try uploading page photos instead.');
        return [{ type: 'text', text: `<document>\n${text}\n</document>` }, intro];
      },
    };
  }
  if (IMAGE_TYPES.includes(doc.mime)) {
    const data = fs.readFileSync(file).toString('base64');
    return { primary: [{ type: 'image', source: { type: 'base64', media_type: doc.mime, data } }, intro] };
  }
  const text = fs.readFileSync(file, 'utf8').slice(0, MAX_TEXT_CHARS);
  return { primary: [{ type: 'text', text: `<document>\n${text}\n</document>` }, intro] };
}

// ---------- queue: one document at a time ----------

let running = false;

async function analyzeOne(doc) {
  const blocks = await documentBlocks(doc);
  try {
    return await callClaude(blocks.primary, DOC_SCHEMA, SYSTEM);
  } catch (err) {
    if (blocks.fallback && err.status === 400) return callClaude(await blocks.fallback(), DOC_SCHEMA, SYSTEM);
    throw err;
  }
}

async function drain() {
  if (running || !client) return;
  running = true;
  try {
    let doc;
    while ((doc = db.prepare("SELECT * FROM documents WHERE status = 'queued' ORDER BY id LIMIT 1").get())) {
      db.prepare("UPDATE documents SET status = 'processing', error = NULL WHERE id = ?").run(doc.id);
      try {
        const analysis = await analyzeOne(doc);
        db.prepare("UPDATE documents SET status = 'done', analysis = ?, analyzed_at = datetime('now') WHERE id = ?")
          .run(JSON.stringify(analysis), doc.id);
      } catch (err) {
        console.error(`analyze doc ${doc.id}:`, err.message);
        db.prepare("UPDATE documents SET status = 'error', error = ? WHERE id = ?").run(err.message || 'Analysis failed', doc.id);
      }
    }
  } finally {
    running = false;
  }
}

// Combined review across every analyzed document (works from the per-document results, not the files).
async function summarize() {
  if (!client) throw new Error('ANTHROPIC_API_KEY is not set');
  const docs = db.prepare("SELECT id, original_name, analysis FROM documents WHERE status = 'done' ORDER BY id").all();
  if (!docs.length) throw new Error('No analyzed documents yet.');
  const payload = docs.map(d => ({ document: d.original_name, analysis: JSON.parse(d.analysis) }));
  const summary = await callClaude(
    [{ type: 'text', text: `Here are the per-document reviews of ${docs.length} medical document(s):\n\n${JSON.stringify(payload, null, 1)}\n\nWrite the combined review across all of them. Reference documents by file name. In gaps/missing_pieces, name the specific evidence that would strengthen a sleep apnea diagnosis or VA claim and isn't in these records (e.g. a sleep study, a nexus letter, service treatment records, a buddy statement).` }],
    SUMMARY_SCHEMA,
    SYSTEM,
  );
  const info = db.prepare('INSERT INTO summaries (doc_ids, summary) VALUES (?, ?)')
    .run(JSON.stringify(docs.map(d => d.id)), JSON.stringify(summary));
  return { id: info.lastInsertRowid, doc_ids: docs.map(d => d.id), summary, created_at: new Date().toISOString() };
}

module.exports = { drain, summarize, UPLOAD_DIR, IMAGE_TYPES, hasKey: () => !!client };
