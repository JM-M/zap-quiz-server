# WebSocket Implementation

This directory contains the WebSocket implementation for real-time game functionality using Socket.IO.

## Architecture

### Core Components

1. **GameGateway** (`game.gateway.ts`) - Main WebSocket gateway handling connections and events
2. **GameService** (`../services/game.service.ts`) - Business logic layer for game operations
3. **WebSocketModule** (`websocket.module.ts`) - NestJS module configuration

### Room Management

- Each game has its own WebSocket room: `game-{gameId}`
- Players are automatically added to rooms when joining games
- Rooms are cleaned up automatically when empty

## WebSocket Events

### Client → Server Events

| Event             | Data                                                                                               | Description                |
| ----------------- | -------------------------------------------------------------------------------------------------- | -------------------------- |
| `JOIN_GAME`       | `{ gameCode: string, playerName: string, userId?: string }`                                        | Join a game by code        |
| `LEAVE_GAME`      | `{ gameId: string, playerId: string }`                                                             | Leave the current game     |
| `START_GAME`      | `{ gameId: string, hostId: string }`                                                               | Start the game (host only) |
| `ANSWER_QUESTION` | `{ gameId: string, playerId: string, questionId: string, optionId: string, timeToAnswer: number }` | Submit an answer           |

### Server → Client Events

| Event                | Data                                                                                                 | Description                      |
| -------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------- |
| `JOIN_GAME_SUCCESS`  | `{ player: Player, gameId: string }`                                                                 | Confirmation of successful join  |
| `LEAVE_GAME_SUCCESS` | `{ gameId: string }`                                                                                 | Confirmation of successful leave |
| `PLAYER_JOINED`      | `{ player: Player }`                                                                                 | Another player joined the game   |
| `PLAYER_LEFT`        | `{ playerId: string, gameId: string }`                                                               | A player left the game           |
| `GAME_STARTED`       | `{ gameId: string, startedAt: string }`                                                              | Game has started                 |
| `PLAYER_ANSWERED`    | `{ playerId: string, questionId: string, timeToAnswer: number, isCorrect: boolean, points: number }` | A player answered a question     |
| `ERROR`              | `{ message: string }`                                                                                | Error occurred                   |

## Integration with tRPC

The WebSocket layer works alongside your existing tRPC setup:

1. **Initial Data**: Use tRPC for initial data fetching (game details, player lists)
2. **Real-time Updates**: Use WebSocket events for live updates
3. **Optimistic Updates**: Update React Query cache directly from WebSocket events

### Example Integration Pattern

```typescript
// 1. Fetch initial data with tRPC
const { data: game } = useQuery(trpc.game.getGameByCode.queryOptions({ code }));

// 2. Connect to WebSocket
useEffect(() => {
  socket.emit('JOIN_GAME', { gameCode: code, playerName: user.name });
}, []);

// 3. Handle real-time updates
useEffect(() => {
  socket.on('PLAYER_JOINED', (data) => {
    // Update React Query cache optimistically
    queryClient.setQueryData(
      ['game', 'getGamePlayers', { gameId: data.player.gameId }],
      (oldPlayers) => [...(oldPlayers || []), data.player],
    );
  });
}, []);
```

## Database Integration

The `GameService` contains placeholder methods that need to be replaced with actual database operations using your Drizzle setup:

```typescript
// Replace these placeholder methods with actual Drizzle queries:
-findGameByCode() -
  addPlayerToGame() -
  removePlayerFromGame() -
  startGame() -
  getGamePlayers() -
  savePlayerAnswer() -
  isUserHost();
```

## Environment Variables

Set the following environment variable for CORS configuration:

```bash
CLIENT_URL=http://localhost:3000
```

## Testing

Use the provided client example (`../examples/websocket-client-example.ts`) to test WebSocket functionality.

## Next Steps

1. **Database Integration**: Replace placeholder methods in `GameService` with actual Drizzle queries
2. **Authentication**: Add JWT token validation for WebSocket connections
3. **Error Handling**: Implement comprehensive error handling and reconnection logic
4. **Client Integration**: Integrate WebSocket client into your React application
5. **Testing**: Add unit and integration tests for WebSocket functionality
