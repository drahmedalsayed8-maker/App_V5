// netlify/functions/ai.js

function buildTaskSystemPrompt(task){
  switch (String(task || "")) {
    case "voice_to_report":
      return "You are a dental radiology assistant. Convert the provided transcript/notes into a structured clinical report (clear sections, concise, professional).";
    case "ask_radiology":
      return "You are a dental radiology consultant. Answer clinically, reference CBCT/panoramic findings when provided, and be concise.";
    case "panorama_json_to_report":
      return "You are a dental imaging assistant. Convert the provided panoramic analysis JSON into a structured report with findings and recommendations.";
    case "ceph_treatment_planner":
      return "You are an orthodontic assistant. Use the provided cephalometric data to propose a treatment plan with rationale and steps.";
    default:
      return "You are a helpful dental assistant. Respond clearly and concisely.";
  }
}

function extractUserContent(incoming){
  // 1) messages (highest priority)
  if (Array.isArray(incoming.messages) && incoming.messages.length) return { kind: "messages" };

  // 2) prompt/text/input (legacy)
  if (incoming.prompt) return { kind: "prompt", text: String(incoming.prompt) };
  if (incoming.text) return { kind: "prompt", text: String(incoming.text) };
  if (incoming.input) return { kind: "prompt", text: String(incoming.input) };

  // 3) task/payload/meta (RRZ_AI)
  if (incoming.task) {
    const task = String(incoming.task);
    const payload = incoming.payload || {};
    const meta = incoming.meta || {};
    const text =
      payload.text ?? payload.prompt ?? payload.transcript ?? payload.notes ?? payload.question ??
      (typeof payload === "string" ? payload : "") ??
      "";

    return {
      kind: "task",
      task,
      payload,
      meta,
      text: typeof text === "string" ? text : JSON.stringify(text)
    };
  }

  return { kind: "none" };
}

exports.handler = async (event) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  try {
    const incoming = JSON.parse(event.body || "{}");

    const provider = (process.env.AI_PROVIDER || "openrouter").toLowerCase();
    const model = process.env.MODEL_TEXT || "google/gemma-3-12b-it:free";

    if (provider !== "openrouter") {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Unsupported provider", provider }),
      };
    }

    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Missing OPENROUTER_API_KEY" }),
      };
    }

    // Build messages
    const mode = extractUserContent(incoming);
    let messages;

    if (mode.kind === "messages") {
      messages = incoming.messages;
    } else if (mode.kind === "prompt") {
      messages = [{ role: "user", content: mode.text }];
    } else if (mode.kind === "task") {
      const sys = buildTaskSystemPrompt(mode.task);
      const packed =
        mode.text && mode.text.trim()
          ? mode.text
          : JSON.stringify({ payload: mode.payload, meta: mode.meta }, null, 2);

      // ✅ FIX: avoid role="system" (some free routes/models reject it -> 400)
      messages = [
        { role: "user", content: `SYSTEM:\n${sys}\n\nUSER:\n${packed}` }
      ];
    } else {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Missing prompt/messages/task in request body" }),
      };
    }

    // Guard
    if (!messages?.length || !messages[0]?.content) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ ok: false, error: "Empty messages" }),
      };
    }

    const url = "https://openrouter.ai/api/v1/chat/completions";
    const payload = {
      model,
      messages,
      temperature: incoming.temperature ?? 0.2,
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://darling-crumble-f08197.netlify.app",
        "X-Title": "Royal Ray Zone",
      },
      body: JSON.stringify(payload),
    });

    const textRaw = await r.text();
    let data;
    try { data = textRaw ? JSON.parse(textRaw) : {}; } catch { data = { raw: textRaw }; }

    if (!r.ok) {
      console.error("UPSTREAM_ERROR", {
        upstream_status: r.status,
        upstream_body: (textRaw || "").slice(0, 2000),
      });

      return {
        statusCode: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          ok: false,
          error: "AI upstream error",
          upstream_status: r.status,
          upstream_body: (textRaw || "").slice(0, 2000),
        }),
      };
    }

    const aiText = data?.choices?.[0]?.message?.content ?? "";
    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        text: aiText,
        raw: data,
      }),
    };
  } catch (e) {
    console.error("FUNCTION_CRASH", e);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "Function error", details: String(e) }),
    };
  }
};
