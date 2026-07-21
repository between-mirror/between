# prompt: l1-emotion (v1) — per-message emotion & warmth

*The MVP's sole lens. `kind:"map"`, `engine_hint:"local"` for bulk volume (Ollama), `"claude"` for nuanced residue (prefilter-flagged sarcasm/mixed windows). Output feeds the Sentiment River (per-day warmth/tension aggregates) and the Evidence Panel.*

## Instructions (interpolated into the job file)

```
You are scoring the emotional texture of a private text conversation for the sender's own
self-reflection. They have consented to this analysis of their own archive. Be accurate,
not charitable or alarmist. Sarcasm, jokes, and quoted speech are common — read pragmatics,
not just words. Messages are prefixed [mID] SPEAKER (ME = the archive owner, THEM = the other party).

For EVERY message in the transcript, return one entry. Then summarize the window.

Scoring:
- warmth 0-3: affection, care, play, appreciation actually expressed (not politeness filler)
- tension 0-3: hostility, coldness, hurt, pressure, contempt actually expressed
- a message can be high in both (a loving jab), or 0/0 (logistics)
- valence -1.0..1.0: overall emotional tone
- tone_flags only when clearly present; prefer none over noise

Return ONLY JSON matching the schema. Every window_note MUST cite evidence_ids.
If you cannot analyze this content, return {"refused": true, "reason": "..."}.
```

## output_schema (JSON Schema, embedded in each job)

```json
{
  "type": "object", "required": ["messages", "window"],
  "properties": {
    "messages": { "type": "array", "items": {
      "type": "object",
      "required": ["message_id", "valence", "warmth", "tension"],
      "properties": {
        "message_id": { "type": "string", "pattern": "^m[0-9]+$" },
        "valence":    { "type": "number", "minimum": -1, "maximum": 1 },
        "warmth":     { "type": "integer", "minimum": 0, "maximum": 3 },
        "tension":    { "type": "integer", "minimum": 0, "maximum": 3 },
        "tone_flags": { "type": "array", "items": { "enum":
          ["sarcasm","passive_aggressive","contempt","anxious","defensive",
           "playful","affectionate","apologetic","withdrawn","pressuring"] } },
        "note": { "type": "string", "maxLength": 140 }
      } } },
    "window": {
      "type": "object", "required": ["summary", "notes"],
      "properties": {
        "summary": { "type": "string", "maxLength": 300 },
        "notes": { "type": "array", "items": {
          "type": "object", "required": ["claim", "evidence_ids"],
          "properties": {
            "claim":        { "type": "string", "maxLength": 200 },
            "evidence_ids": { "type": "array", "minItems": 1, "items": { "type": "string" } },
            "confidence":   { "enum": ["surer", "less_sure"] } } } },
        "worth_deeper_look": { "type": "boolean" }
      } }
  }
}
```

## Aggregation (app-side, no model)

Per day per party: `warmth_day = mean(warmth of substantive msgs)`, same for tension; river thickness = message count. `worth_deeper_look` + prefilter conjunctions feed the Phase-3 routing. Reactions and `is_reaction` rows never enter this lens.
