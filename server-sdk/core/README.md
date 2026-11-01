# Shared server core

Requires Node.js 22+. From the repository root:

```sh
npm ci
npm run build --workspace @gelato/server-core
```

Embed the gateway in your HTTP/authentication service:

```ts
import express from 'express';
import { createServer } from 'node:http';
import { GelatoServer } from '@gelato/server-core';

const app = express();
const gateway = new GelatoServer({
  stateDirectory: process.env.GALATEA_STATE_DIR ?? './device-state',
  grants: () => JSON.parse(process.env.GALATEA_GRANTS ?? '[]'),
});
app.use(express.json({ limit: '32kb' }));
app.use('/v1', gateway.router);
const server = createServer(app);
gateway.attach(server);
server.listen(8090, '127.0.0.1');
```

Keep state private. Access grants contain `token`, `userId`, `deviceIds`,
`capabilities` and `expiresAt` (Unix milliseconds); an empty array denies access.
Behind application authentication, create pairing links with
`gateway.pairing.createSession({ownerUserId, controllerUrl})`.
Use HTTPS for remote clients.

| Method | Route under `/v1` |
| --- | --- |
| GET | `/devices` |
| GET | `/devices/:id/observations?after=N&epoch=E` |
| POST | `/devices/:id/commands` |
| GET | `/commands/:id` |
| POST | `/commands/:id/cancel` |
| GET | `/devices/:id/streams/:streamId/content` |

Requests require `Authorization: Bearer TOKEN`. Command bodies contain
`command_id`, `capability`, `arguments` and `deadline_ms`. Reuse an ID only for
the same request; poll status for the result. Pass observation cursor and epoch
when fetching subsequent frames.

`GelatoClient` uses `/v1`; `GelatoHost` uses `/harness/v1` for the
[control-room example](../../examples/server/control-room/).

Model adapters and the persistent `ModelSessionEndpoint` WebSocket client now
live in [`model_interface/`](../../model_interface/README.md). A Controller
passes its selected `ModelEndpoint` to `ModelBridge`; the bridge delivers final
text replies but never executes model action proposals. The model interface
client can forward proposals to a Controller-owned callback that checks the
current device session and permissions. `ModelEndpoint.generate` also accepts
an optional `onDelta` callback for Controller surfaces that want streaming
text; device-side v1 `reply.deliver` still receives the final reply.
