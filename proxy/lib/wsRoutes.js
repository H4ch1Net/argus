// One upgrade router per HTTP server for the proxy's websocket endpoints.
//
// Why this exists: `new WebSocketServer({ server, path })` adds its own 'upgrade'
// listener, and in ws v8 a server whose path does not match ABORTS the handshake
// with a 400 instead of passing it on. With /ws/ais, /ws/bgp and /ws/ct all on
// one server, only the first-attached path ever connected. The fix (the pattern
// the ws docs prescribe) is noServer websocket servers behind a single listener
// that dispatches by pathname.

/** @type {WeakMap<import('node:http').Server, Map<string, import('ws').WebSocketServer>>} */
const routers = new WeakMap();

function rejectUpgrade(socket, status, reason) {
  try {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  } catch {
    // socket already gone
  }
  socket.destroy();
}

/**
 * Register a noServer WebSocketServer for one path on an HTTP(S) server.
 * @param {import('node:http').Server} server
 * @param {string} path  exact pathname, e.g. '/ws/bgp'
 * @param {import('ws').WebSocketServer} wss  created with { noServer: true }
 */
export function routeUpgrade(server, path, wss) {
  let routes = routers.get(server);
  if (!routes) {
    routes = new Map();
    routers.set(server, routes);
    server.on('upgrade', (req, socket, head) => {
      let pathname = null;
      try {
        pathname = new URL(req.url, 'http://proxy.local').pathname;
      } catch {
        // malformed request target: falls through to 404
      }
      const target = pathname ? routes.get(pathname) : null;
      if (!target) {
        rejectUpgrade(socket, 404, 'Not Found');
        return;
      }
      target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
    });
  }
  routes.set(path, wss);
  wss.on('close', () => {
    if (routes.get(path) === wss) routes.delete(path);
  });
}
