import { Module } from '@nestjs/common';
import { GameGateway } from './game.gateway';
import { GameService } from '../services/game.service';

@Module({
  providers: [GameGateway, GameService],
  exports: [GameGateway, GameService],
})
export class WebSocketModule {}
