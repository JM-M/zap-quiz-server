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
  userId?: string;
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
    { socket: Socket; gameId?: string; playerId?: string }
  >();

  constructor(private readonly gameService: GameService) {}

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    console.log('🔌 Client connected:', client.id);
    this.connectedClients.set(client.id, { socket: client });
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
    }

    this.connectedClients.delete(client.id);
  }

  @SubscribeMessage('JOIN_GAME')
  async handleJoinGame(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: JoinGameData,
  ) {
    try {
      this.logger.log(
        `Player ${data.playerName} joining game ${data.gameCode}`,
      );

      // Find the game by code
      const game = await this.gameService.findGameByCode(data.gameCode);
      if (!game) {
        client.emit('ERROR', { message: 'Game not found' });
        return;
      }

      // Check if game is joinable
      if (game.status !== 'waiting') {
        client.emit('ERROR', {
          message: `Cannot join game. Game status is: ${game.status}`,
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
        client.emit('ERROR', {
          message: result.error || 'Failed to join game',
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

      // Notify all players in the room that someone joined
      this.server
        .to(this.getRoomName(game.id))
        .emit('PLAYER_JOINED', { player });

      // Send confirmation to the joining player
      client.emit('JOIN_GAME_SUCCESS', { player, gameId: game.id });
    } catch (error) {
      this.logger.error('Error joining game:', error);
      client.emit('ERROR', { message: 'Failed to join game' });
    }
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
      console.log('🎮 JOIN_LOBBY received:', data);

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
    const room = this.server.sockets.adapter.rooms.get(
      this.getRoomName(gameId),
    );
    return room ? Array.from(room) : [];
  }
}
