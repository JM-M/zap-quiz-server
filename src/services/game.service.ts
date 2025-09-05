import { Injectable, Logger } from '@nestjs/common';
import { db } from '../db';
import {
  games,
  players,
  questions,
  questionOptions,
  playerAnswers,
} from '../db/schema';
import { eq, and } from 'drizzle-orm';

// Types for game operations
export interface Game {
  id: string;
  code: string;
  title: string;
  status: 'waiting' | 'in_progress' | 'completed' | 'cancelled';
  hostId: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  settings?: {
    timeLimit?: number;
    allowLateJoins?: boolean;
    showCorrectAnswers?: boolean;
  };
}

export interface Player {
  id: string;
  gameId: string;
  name: string;
  userId: string;
  isHost: boolean;
  joinedAt: Date;
  leftAt?: Date;
  isActive: boolean;
}

export interface JoinGameResult {
  success: boolean;
  player?: Player;
  game?: Game;
  error?: string;
}

@Injectable()
export class GameService {
  private readonly logger = new Logger(GameService.name);

  async findGameByCode(code: string): Promise<Game | null> {
    this.logger.log(`Looking up game with code: ${code}`);

    try {
      const [game] = await db
        .select()
        .from(games)
        .where(eq(games.code, code))
        .limit(1);

      if (!game) {
        return null;
      }

      return {
        id: game.id,
        code: game.code,
        title: game.title || `Game ${code}`,
        status: game.status as
          | 'waiting'
          | 'in_progress'
          | 'completed'
          | 'cancelled',
        hostId: game.hostId,
        createdAt: game.createdAt,
        updatedAt: game.updatedAt,
        startedAt: game.startedAt || undefined,
        completedAt: game.completedAt || undefined,
        settings: game.settings || undefined,
      };
    } catch (error) {
      this.logger.error('Error finding game by code:', error);
      return null;
    }
  }

  async addPlayerToGame(
    gameId: string,
    playerName: string,
    userId: string,
  ): Promise<JoinGameResult> {
    this.logger.log(`Adding player ${playerName} to game ${gameId}`);

    try {
      // 1. Check if game exists and is joinable
      const gameResult = await db
        .select()
        .from(games)
        .where(eq(games.id, gameId))
        .limit(1);

      if (gameResult.length === 0) {
        return {
          success: false,
          error: 'Game not found',
        };
      }

      const game = gameResult[0];
      if (game.status !== 'waiting') {
        return {
          success: false,
          error: `Cannot join game. Game status is: ${game.status}`,
        };
      }

      // 2. Check if user is already in the game
      const existingPlayer = await db
        .select()
        .from(players)
        .where(
          and(
            eq(players.gameId, gameId),
            eq(players.userId, userId),
            eq(players.isActive, true),
          ),
        )
        .limit(1);

      if (existingPlayer.length > 0) {
        return {
          success: true,
          player: {
            id: existingPlayer[0].id,
            gameId: existingPlayer[0].gameId,
            name: existingPlayer[0].name,
            userId: existingPlayer[0].userId,
            isHost: existingPlayer[0].isHost,
            joinedAt: existingPlayer[0].joinedAt,
            leftAt: existingPlayer[0].leftAt || undefined,
            isActive: existingPlayer[0].isActive,
          },
        };
      }

      // 3. Create player record
      const newPlayer = await db
        .insert(players)
        .values({
          gameId,
          name: playerName,
          userId,
          isHost: false,
          isActive: true,
        })
        .returning();

      const player = newPlayer[0];

      return {
        success: true,
        player: {
          id: player.id,
          gameId: player.gameId,
          name: player.name,
          userId: player.userId,
          isHost: player.isHost,
          joinedAt: player.joinedAt,
          leftAt: player.leftAt || undefined,
          isActive: player.isActive,
        },
      };
    } catch (error) {
      this.logger.error('Error adding player to game:', error);
      return {
        success: false,
        error: 'Failed to join game',
      };
    }
  }

  async removePlayerFromGame(
    gameId: string,
    playerId: string,
  ): Promise<boolean> {
    this.logger.log(`Removing player ${playerId} from game ${gameId}`);

    try {
      // 1. Update player record to set isActive = false and set leftAt timestamp
      await db
        .update(players)
        .set({
          isActive: false,
          leftAt: new Date(),
        })
        .where(and(eq(players.id, playerId), eq(players.gameId, gameId)));

      return true;
    } catch (error) {
      this.logger.error('Error removing player from game:', error);
      return false;
    }
  }

  async startGame(gameId: string, hostId: string): Promise<boolean> {
    this.logger.log(`Starting game ${gameId} by host ${hostId}`);

    try {
      // 1. Verify the user is the host
      const isHost = await this.isUserHost(gameId, hostId);
      if (!isHost) {
        this.logger.warn(`User ${hostId} is not the host of game ${gameId}`);
        return false;
      }

      // 2. Update game status to 'in_progress' and set startedAt timestamp
      await db
        .update(games)
        .set({
          status: 'in_progress',
          startedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(games.id, gameId));

      return true;
    } catch (error) {
      this.logger.error('Error starting game:', error);
      return false;
    }
  }

  async getGamePlayers(gameId: string): Promise<Player[]> {
    this.logger.log(`Getting players for game ${gameId}`);

    try {
      const result = await db
        .select()
        .from(players)
        .where(and(eq(players.gameId, gameId), eq(players.isActive, true)));

      return result.map((player) => ({
        id: player.id,
        gameId: player.gameId,
        name: player.name,
        userId: player.userId,
        isHost: player.isHost,
        joinedAt: player.joinedAt,
        leftAt: player.leftAt || undefined,
        isActive: player.isActive,
      }));
    } catch (error) {
      this.logger.error('Error getting game players:', error);
      return [];
    }
  }

  async savePlayerAnswer(
    playerId: string,
    questionId: string,
    optionId: string,
    timeToAnswer: number,
  ): Promise<{ success: boolean; isCorrect: boolean; points: number }> {
    this.logger.log(
      `Saving answer for player ${playerId}, question ${questionId}`,
    );

    try {
      // 1. Get question and option details
      const [questionResult, optionResult] = await Promise.all([
        db
          .select()
          .from(questions)
          .where(eq(questions.id, questionId))
          .limit(1),
        db
          .select()
          .from(questionOptions)
          .where(eq(questionOptions.id, optionId))
          .limit(1),
      ]);

      if (questionResult.length === 0 || optionResult.length === 0) {
        return {
          success: false,
          isCorrect: false,
          points: 0,
        };
      }

      const question = questionResult[0];
      const option = optionResult[0];
      const isCorrect = option.isCorrect;
      const points = isCorrect ? question.points : 0;

      // 2. Save player answer
      await db.insert(playerAnswers).values({
        playerId,
        questionId,
        optionId,
        timeToAnswer,
        isCorrect,
      });

      return {
        success: true,
        isCorrect,
        points,
      };
    } catch (error) {
      this.logger.error('Error saving player answer:', error);
      return {
        success: false,
        isCorrect: false,
        points: 0,
      };
    }
  }

  async isUserHost(gameId: string, userId: string): Promise<boolean> {
    this.logger.log(`Checking if user ${userId} is host of game ${gameId}`);

    try {
      const result = await db
        .select()
        .from(games)
        .where(eq(games.id, gameId))
        .limit(1);

      if (result.length === 0) {
        return false;
      }

      return result[0].hostId === userId;
    } catch (error) {
      this.logger.error('Error checking host status:', error);
      return false;
    }
  }
}
