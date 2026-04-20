import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { SupabaseModule } from "./common/supabase/supabase.module";
import { AuthModule } from "./auth/auth.module";
import { DeploymentsModule } from "./deployments/deployments.module";
import { MissionsModule } from "./missions/missions.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { AlertsModule } from "./alerts/alerts.module";
import { ArksModule } from "./arks/arks.module";
import { PublicRtspModule } from "./public-rtsp/public-rtsp.module";
import { AiModule } from "./ai/ai.module";
import { AdminModule } from "./admin/admin.module";
import path from "node:path";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Ensures Nest loads the correct env file even if CWD differs.
      envFilePath: [
        path.resolve(__dirname, "..", ".env"),
        path.resolve(__dirname, "..", `.env.${process.env.NODE_ENV || "development"}`),
      ],
    }),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // `config.get()` có thể trả về chuỗi rỗng "" nếu env tồn tại nhưng trống.
        // JwtService cần secret khác rỗng.
        secret: (() => {
          const raw = config.get<string>("JWT_SECRET");
          const trimmed = raw?.trim();
          // Don't log secret contents; only indicate whether it's set.
          // eslint-disable-next-line no-console
          console.log("[jwt] JWT_SECRET configured:", !!trimmed);
          return trimmed ? trimmed : "dev_jwt_secret";
        })(),
        signOptions: {
          algorithm: "HS256",
          // Nest typings expect number or StringValue; normalize env like "3600s" -> 3600.
          expiresIn: Number(
            String(config.get<string>("JWT_EXPIRES_IN") ?? "3600s").replace(/[^0-9]/g, ""),
          ),
        },
      }),
    }),
    SupabaseModule,
    AuthModule,
    DeploymentsModule,
    MissionsModule,
    DashboardModule,
    AlertsModule,
    ArksModule,
    PublicRtspModule,
    AiModule,
    AdminModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
