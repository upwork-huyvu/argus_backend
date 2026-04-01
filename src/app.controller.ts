import { Controller, Get, Redirect } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Redirect('/docs', 302)
  rootRedirect(): void {
    // handler body unused — Redirect decorator sends 302
  }

  @Get('health')
  getHealth(): string {
    return this.appService.getHello();
  }
}
