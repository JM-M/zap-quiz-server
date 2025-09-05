import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { user } from './auth';

// Games table - Main quiz sessions
export const games = pgTable(
  'games',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    title: text('title'),
    status: text('status', {
      enum: ['waiting', 'in_progress', 'completed', 'cancelled'],
    })
      .notNull()
      .default('waiting'),
    hostId: text('host_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    startedAt: timestamp('started_at'),
    completedAt: timestamp('completed_at'),
    settings: jsonb('settings').$type<{
      timeLimit?: number;
      allowLateJoins?: boolean;
      showCorrectAnswers?: boolean;
    }>(),
  },
  (table) => [index('idx_games_code').on(table.code)],
);

// Questions table - Quiz questions
export const questions = pgTable(
  'questions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    prompt: text('prompt').notNull(),
    order: integer('order').notNull(),
    timeLimit: integer('time_limit'), // seconds, nullable for no time limit
    points: integer('points').notNull().default(1),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_questions_game_id').on(table.gameId),
    index('idx_questions_game_order').on(table.gameId, table.order),
  ],
);

// Question Options table - Answer choices
export const questionOptions = pgTable(
  'question_options',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    isCorrect: boolean('is_correct').notNull().default(false),
    order: integer('order').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_question_options_question_id').on(table.questionId),
    index('idx_question_options_question_order').on(
      table.questionId,
      table.order,
    ),
  ],
);

// Players table - Game participants
export const players = pgTable(
  'players',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    isHost: boolean('is_host').notNull().default(false),
    joinedAt: timestamp('joined_at').notNull().defaultNow(),
    leftAt: timestamp('left_at'),
    isActive: boolean('is_active').notNull().default(true),
  },
  (table) => [
    index('idx_players_game_id').on(table.gameId),
    index('idx_players_game_active').on(table.gameId, table.isActive),
    index('idx_players_user_id').on(table.userId),
  ],
);

// Player Answers table - Individual responses
export const playerAnswers = pgTable(
  'player_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    questionId: uuid('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    optionId: uuid('option_id')
      .notNull()
      .references(() => questionOptions.id, { onDelete: 'cascade' }),
    answeredAt: timestamp('answered_at').notNull().defaultNow(),
    timeToAnswer: integer('time_to_answer').notNull(), // milliseconds taken to answer
    isCorrect: boolean('is_correct').notNull(), // denormalized for performance
  },
  (table) => [
    index('idx_player_answers_player_question').on(
      table.playerId,
      table.questionId,
    ),
    index('idx_player_answers_question').on(table.questionId),
    index('idx_player_answers_player').on(table.playerId),
  ],
);

// Player Scores table - Aggregated scores
export const playerScores = pgTable(
  'player_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    gameId: uuid('game_id')
      .notNull()
      .references(() => games.id, { onDelete: 'cascade' }),
    totalScore: integer('total_score').notNull().default(0),
    questionsAnswered: integer('questions_answered').notNull().default(0),
    correctAnswers: integer('correct_answers').notNull().default(0),
    averageResponseTime: integer('average_response_time').notNull().default(0), // milliseconds
    rank: integer('rank').notNull().default(1),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('idx_player_scores_game_rank').on(table.gameId, table.rank),
    index('idx_player_scores_player').on(table.playerId),
    index('idx_player_scores_game').on(table.gameId),
  ],
);

// Relations
export const gamesRelations = relations(games, ({ one, many }) => ({
  host: one(user, {
    fields: [games.hostId],
    references: [user.id],
  }),
  questions: many(questions),
  players: many(players),
  playerScores: many(playerScores),
}));

export const questionsRelations = relations(questions, ({ one, many }) => ({
  game: one(games, {
    fields: [questions.gameId],
    references: [games.id],
  }),
  options: many(questionOptions),
  playerAnswers: many(playerAnswers),
}));

export const questionOptionsRelations = relations(
  questionOptions,
  ({ one, many }) => ({
    question: one(questions, {
      fields: [questionOptions.questionId],
      references: [questions.id],
    }),
    playerAnswers: many(playerAnswers),
  }),
);

export const playersRelations = relations(players, ({ one, many }) => ({
  game: one(games, {
    fields: [players.gameId],
    references: [games.id],
  }),
  answers: many(playerAnswers),
  scores: many(playerScores),
}));

export const playerAnswersRelations = relations(playerAnswers, ({ one }) => ({
  player: one(players, {
    fields: [playerAnswers.playerId],
    references: [players.id],
  }),
  question: one(questions, {
    fields: [playerAnswers.questionId],
    references: [questions.id],
  }),
  option: one(questionOptions, {
    fields: [playerAnswers.optionId],
    references: [questionOptions.id],
  }),
}));

export const playerScoresRelations = relations(playerScores, ({ one }) => ({
  player: one(players, {
    fields: [playerScores.playerId],
    references: [players.id],
  }),
  game: one(games, {
    fields: [playerScores.gameId],
    references: [games.id],
  }),
}));
