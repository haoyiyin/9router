# @haoyiyin/9router

Pi extension — a **9Router provider** (including OpenCode Free `oc/` models) plus `fetch`, `search`, and `transcribe` tools.

A fork of [`@xynogen/pix-9router`](https://www.npmjs.com/package/@xynogen/pix-9router) that fixes the issue where 9router's `/v1/models` never lists OpenCode Free `-free` models — this extension exposes those `oc/` models directly.

## Install

```
pi install npm:@haoyiyin/9router
```

## Configure

There is no built-in default endpoint. Run `/login`, select **9Router**, and enter the base URL and API key. They are saved to `~/.pi/agent/haoyiyin/9router.json` (mode `0600`). `/logout` removes the stored credential.

Environment variables are supported as a fallback: `ROUTER_API_BASE` / `ROUTER_API_KEY` (the config file takes precedence).

## Combo models & thinking

Combo models (`sub` / `free` / `main`, `owned_by: "combo"`) advertise no capabilities from the router, so their reasoning is decided by `comboReasoning` in `~/.pi/agent/haoyiyin/9router.json`. It defaults to **on** (assumes combo routes hit thinking-capable upstreams) with the full `off..max` range. Opt out per machine with:

```json
{
  "comboReasoning": false
}
```

To override that default range, pass a custom `thinkingLevelMap` (keys: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; values: what gets sent to the router, `null` hides the level). For example, to cap combo models at `high`:

```json
{
  "comboReasoning": { "thinkingLevelMap": { "xhigh": null, "max": null } }
}
```

## oc models

Every 30 minutes the extension fetches models from `opencode.ai/zen/v1/models` whose ids end in `-free`, and registers them under the 9router provider as `oc/<id>`. Changes to the upstream list are picked up automatically. Cache file: `~/.cache/pi/zen-oc-models.json`.

## Tools

`fetch` / `search` / `transcribe` behave the same as `pix-9router`; collapse config still lives in `~/.pi/agent/pix.json`.

## License

MIT
