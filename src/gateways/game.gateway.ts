import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { GameService } from '../services/game.service';

// Types for WebSocket events
interface JoinGameData {
  gameCode: string;
  playerName: string;
  userId: string;
}

interface LeaveGameData {
  gameId: string;
  playerId: string;
}

interface StartGameData {
  gameId: string;
  hostId: string;
}

interface AnswerQuestionData {
  gameId: string;
  playerId: string;
  questionId: string;
  optionId: string;
  timeToAnswer: number;
}

interface JoinLobbyData {
  gameCode: string;
  playerName: string;
  userId?: string;
}

interface LeaveLobbyData {
  gameId: string;
  playerId: string;
}

interface StartCountdownData {
  gameId: string;
  duration: number; // in seconds
}

interface CountdownTickData {
  gameId: string;
  currentNumber: number;
  remainingTime: number; // milliseconds remaining
}

@WebSocketGateway({
  cors: {
    origin: process.env.CLIENT_URL || 'http://localhost:3000',
    credentials: true,
  },
  namespace: '/game',
})
export class GameGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(GameGateway.name);
  private connectedClients = new Map<
    string,
    { socket: Socket; gameId?: string; playerId?: string; lastPing?: number }
  >();

  private countdownTimers = new Map<string, NodeJS.Timeout>();
  private heartbeatInterval: NodeJS.Timeout;
  private cleanupInterval: NodeJS.Timeout;

  constructor(private readonly gameService: GameService) {
    // Start heartbeat mechanism
    this.startHeartbeat();
    // Start periodic cleanup of inactive players
    this.startInactivePlayerCleanup();
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    this.connectedClients.set(client.id, {
      socket: client,
      lastPing: Date.now(),
    });
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);

    const clientData = this.connectedClients.get(client.id);
    if (clientData?.gameId && clientData?.playerId) {
      // Notify other players that this player left
      this.server.to(`game-${clientData.gameId}`).emit('PLAYER_LEFT', {
        playerId: clientData.playerId,
        gameId: clientData.gameId,
      });

      // Clean up countdown if no more players in the game
      const connectedPlayers = this.getConnectedPlayers(clientData.gameId);
      if (connectedPlayers.length <= 1) {
        this.clearCountdown(clientData.gameId);
      }
    }

    this.connectedClients.delete(client.id);
  }

  @SubscribeMessage('LEAVE_GAME')
  async handleLeaveGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: LeaveGameData,
  ) {
    try {
      this.logger.log(`Player ${data.playerId} leaving game ${data.gameId}`);

      // Remove player from game in database
      const success = await this.gameService.removePlayerFromGame(
        data.gameId,
        data.playerId,
      );
      if (!success) {
        client.emit('ERROR', { message: 'Failed to leave game' });
        return;
      }

      // Leave the game room
      await client.leave(this.getRoomName(data.gameId));

      // Update client data
      const clientData = this.connectedClients.get(client.id);
      if (clientData) {
        clientData.gameId = undefined;
        clientData.playerId = undefined;
      }

      // Notify other players in the room
      this.server.to(this.getRoomName(data.gameId)).emit('PLAYER_LEFT', {
        playerId: data.playerId,
        gameId: data.gameId,
      });

      // Send confirmation to the leaving player
      client.emit('LEAVE_GAME_SUCCESS', { gameId: data.gameId });
    } catch (error) {
      this.logger.error('Error leaving game:', error);
      client.emit('ERROR', { message: 'Failed to leave game' });
    }
  }

  @SubscribeMessage('START_GAME')
  async handleStartGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: StartGameData,
  ) {
    try {
      this.logger.log(`Host starting game ${data.gameId}`);

      // Verify that the client is the host
      const isHost = await this.gameService.isUserHost(
        data.gameId,
        data.hostId,
      );
      if (!isHost) {
        client.emit('ERROR', { message: 'Only the host can start the game' });
        return;
      }

      // Start the game in database
      const success = await this.gameService.startGame(
        data.gameId,
        data.hostId,
      );
      if (!success) {
        client.emit('ERROR', { message: 'Failed to start game' });
        return;
      }

      // Notify all players in the room that the game has started
      this.server.to(this.getRoomName(data.gameId)).emit('GAME_STARTED', {
        gameId: data.gameId,
        startedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error starting game:', error);
      client.emit('ERROR', { message: 'Failed to start game' });
    }
  }

  @SubscribeMessage('ANSWER_QUESTION')
  async handleAnswerQuestion(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: AnswerQuestionData,
  ) {
    try {
      this.logger.log(
        `Player ${data.playerId} answered question ${data.questionId}`,
      );

      // Save answer to database
      const result = await this.gameService.savePlayerAnswer(
        data.playerId,
        data.questionId,
        data.optionId,
        data.timeToAnswer,
      );

      if (!result.success) {
        client.emit('ERROR', { message: 'Failed to save answer' });
        return;
      }

      // Notify all players about the answer
      this.server.to(this.getRoomName(data.gameId)).emit('PLAYER_ANSWERED', {
        playerId: data.playerId,
        questionId: data.questionId,
        timeToAnswer: data.timeToAnswer,
        isCorrect: result.isCorrect,
        points: result.points,
      });
    } catch (error) {
      this.logger.error('Error processing answer:', error);
      client.emit('ERROR', { message: 'Failed to process answer' });
    }
  }

  @SubscribeMessage('JOIN_LOBBY')
  async handleJoinLobby(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: JoinLobbyData,
  ) {
    try {
      this.logger.log(
        `Player ${data.playerName} joining lobby for game ${data.gameCode}`,
      );

      // Find the game by code
      const game = await this.gameService.findGameByCode(data.gameCode);
      if (!game) {
        client.emit('LOBBY_ERROR', { message: 'Game not found' });
        return;
      }

      // Check if game is joinable
      if (game.status !== 'waiting') {
        client.emit('LOBBY_ERROR', {
          message: `Cannot join lobby. Game status is: ${game.status}`,
        });
        return;
      }

      // Add player to game
      const result = await this.gameService.addPlayerToGame(
        game.id,
        data.playerName,
        data.userId || `user-${Date.now()}`,
      );

      if (!result.success) {
        client.emit('LOBBY_ERROR', {
          message: result.error || 'Failed to join lobby',
        });
        return;
      }

      const player = result.player!;

      // Join the game room
      await client.join(this.getRoomName(game.id));

      // Update client data
      const clientData = this.connectedClients.get(client.id);
      if (clientData) {
        clientData.gameId = game.id;
        clientData.playerId = player.id;
      }

      // Get current players in the lobby
      const players = await this.gameService.getGamePlayers(game.id);

      // Notify all players in the room that someone joined
      this.server.to(this.getRoomName(game.id)).emit('PLAYER_JOINED_LOBBY', {
        player,
        players, // Send updated player list
        gameId: game.id,
      });

      // Send confirmation to the joining player
      client.emit('LOBBY_JOINED', { player, players, gameId: game.id });
    } catch (error) {
      this.logger.error('Error joining lobby:', error);
      client.emit('LOBBY_ERROR', { message: 'Failed to join lobby' });
    }
  }

  @SubscribeMessage('LEAVE_LOBBY')
  async handleLeaveLobby(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: LeaveLobbyData,
  ) {
    try {
      this.logger.log(
        `Player ${data.playerId} leaving lobby for game ${data.gameId}`,
      );

      // Remove player from game in database
      const success = await this.gameService.removePlayerFromGame(
        data.gameId,
        data.playerId,
      );
      if (!success) {
        client.emit('LOBBY_ERROR', { message: 'Failed to leave lobby' });
        return;
      }

      // Leave the game room
      await client.leave(this.getRoomName(data.gameId));

      // Update client data
      const clientData = this.connectedClients.get(client.id);
      if (clientData) {
        clientData.gameId = undefined;
        clientData.playerId = undefined;
      }

      // Get updated players list
      const players = await this.gameService.getGamePlayers(data.gameId);

      // Notify other players in the room
      this.server.to(this.getRoomName(data.gameId)).emit('PLAYER_LEFT_LOBBY', {
        playerId: data.playerId,
        players, // Send updated player list
        gameId: data.gameId,
      });

      // Send confirmation to the leaving player
      client.emit('LOBBY_LEFT', { gameId: data.gameId });
    } catch (error) {
      this.logger.error('Error leaving lobby:', error);
      client.emit('LOBBY_ERROR', { message: 'Failed to leave lobby' });
    }
  }

  @SubscribeMessage('GET_LOBBY_PLAYERS')
  async handleGetLobbyPlayers(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string },
  ) {
    try {
      this.logger.log(`Getting lobby players for game ${data.gameId}`);

      const players = await this.gameService.getGamePlayers(data.gameId);

      // Send current players to the requesting client
      client.emit('LOBBY_PLAYERS', { players, gameId: data.gameId });
    } catch (error) {
      this.logger.error('Error getting lobby players:', error);
      client.emit('LOBBY_ERROR', { message: 'Failed to get lobby players' });
    }
  }

  @SubscribeMessage('START_COUNTDOWN')
  async handleStartCountdown(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: StartCountdownData,
  ) {
    try {
      this.logger.log(`Starting countdown for game ${data.gameId}`);

      // Clear any existing countdown for this game
      this.clearCountdown(data.gameId);

      // Start new countdown
      this.startCountdown(data.gameId, data.duration);
    } catch (error) {
      this.logger.error('Error starting countdown:', error);
      client.emit('ERROR', { message: 'Failed to start countdown' });
    }
  }

  @SubscribeMessage('STOP_COUNTDOWN')
  async handleStopCountdown(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { gameId: string },
  ) {
    try {
      this.logger.log(`Stopping countdown for game ${data.gameId}`);
      this.clearCountdown(data.gameId);
    } catch (error) {
      this.logger.error('Error stopping countdown:', error);
      client.emit('ERROR', { message: 'Failed to stop countdown' });
    }
  }

  @SubscribeMessage('PING')
  async handlePing(@ConnectedSocket() client: Socket) {
    const clientData = this.connectedClients.get(client.id);
    if (clientData) {
      clientData.lastPing = Date.now();
    }
    client.emit('PONG');
  }

  // Helper method to get room name
  private getRoomName(gameId: string): string {
    return `game-${gameId}`;
  }

  // Helper method to broadcast to a specific game room
  public broadcastToGame(gameId: string, event: string, data: any) {
    this.server.to(this.getRoomName(gameId)).emit(event, data);
  }

  // Helper method to get connected players in a game
  public getConnectedPlayers(gameId: string): string[] {
    try {
      // Check if server, sockets, adapter, and rooms are all available
      if (!this.server?.sockets?.adapter?.rooms) {
        this.logger.warn('Socket.IO adapter rooms not available');
        return [];
      }

      const room = this.server.sockets.adapter.rooms.get(
        this.getRoomName(gameId),
      );
      return room ? Array.from(room) : [];
    } catch (error) {
      this.logger.error('Error getting connected players:', error);
      return [];
    }
  }

  // Countdown management methods
  private startCountdown(gameId: string, duration: number) {
    const startTime = Date.now();
    const endTime = startTime + duration * 1000;

    // Send initial countdown start event
    this.server.to(this.getRoomName(gameId)).emit('COUNTDOWN_START', {
      gameId,
      duration,
      startTime,
      endTime,
    });

    // Set up interval to send countdown ticks
    const interval = setInterval(() => {
      const now = Date.now();
      const remainingTime = Math.max(0, endTime - now);
      const currentNumber = Math.ceil(remainingTime / 1000);

      if (remainingTime <= 0) {
        // Countdown finished
        this.server.to(this.getRoomName(gameId)).emit('COUNTDOWN_END', {
          gameId,
        });
        this.clearCountdown(gameId);
        return;
      }

      // Send countdown tick
      this.server.to(this.getRoomName(gameId)).emit('COUNTDOWN_TICK', {
        gameId,
        currentNumber,
        remainingTime,
      });
    }, 1000); // TODO: Improve this with one or more of the suggestions below
    /*
    Client-side interpolation: Send 1-second server updates but animate smoothly on the client
    Hybrid approach: Server sends 1-second updates, client handles sub-second visual updates
    Progressive timing: Start with 1-second intervals, then switch to 100ms only for the final second
    */

    // Store the interval ID
    this.countdownTimers.set(gameId, interval);
  }

  private clearCountdown(gameId: string) {
    const timer = this.countdownTimers.get(gameId);
    if (timer) {
      clearInterval(timer);
      this.countdownTimers.delete(gameId);
    }
  }

  // Heartbeat mechanism to detect stale connections
  private startHeartbeat() {
    this.heartbeatInterval = setInterval(async () => {
      const now = Date.now();
      const staleThreshold = 30000; // 30 seconds
      const staleClients: string[] = [];

      for (const [clientId, clientData] of this.connectedClients.entries()) {
        const timeSinceLastPing = now - (clientData.lastPing || 0);

        if (timeSinceLastPing > staleThreshold) {
          staleClients.push(clientId);
        }
      }

      // Clean up stale clients
      for (const clientId of staleClients) {
        await this.cleanupStaleClient(clientId);
      }
    }, 15000); // Check every 15 seconds
  }

  private async cleanupStaleClient(clientId: string) {
    const clientData = this.connectedClients.get(clientId);
    if (!clientData) return;

    this.logger.log(`Cleaning up stale client: ${clientId}`);

    // If client was in a game, remove them
    if (clientData.gameId && clientData.playerId) {
      try {
        await this.gameService.removePlayerFromGame(
          clientData.gameId,
          clientData.playerId,
        );

        // Notify other players
        this.server
          .to(this.getRoomName(clientData.gameId))
          .emit('PLAYER_LEFT_LOBBY', {
            playerId: clientData.playerId,
            gameId: clientData.gameId,
            players: await this.gameService.getGamePlayers(clientData.gameId),
          });
      } catch (error) {
        this.logger.error('Error cleaning up stale client:', error);
      }
    }

    // Disconnect the client
    clientData.socket.disconnect();
    this.connectedClients.delete(clientId);
  }

  // Periodic cleanup of inactive players from database
  private startInactivePlayerCleanup() {
    this.cleanupInterval = setInterval(async () => {
      try {
        // Clean up players who have been inactive for more than 5 minutes
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

        // This would need to be implemented in the game service
        // await this.gameService.cleanupInactivePlayers(fiveMinutesAgo);

        this.logger.log('Performed periodic cleanup of inactive players');
      } catch (error) {
        this.logger.error('Error during periodic cleanup:', error);
      }
    }, 60000); // Run every minute
  }

  // Cleanup method for graceful shutdown
  onModuleDestroy() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Clear all countdown timers
    for (const timer of this.countdownTimers.values()) {
      clearInterval(timer);
    }
  }
}
