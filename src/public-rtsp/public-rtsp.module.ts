import { Module } from "@nestjs/common";
import { SupabaseModule } from "../common/supabase/supabase.module";
import { PublicRtspController } from "./public-rtsp.controller";
import { PublicRtspService } from "./public-rtsp.service";

@Module({
  imports: [SupabaseModule],
  controllers: [PublicRtspController],
  providers: [PublicRtspService],
})
export class PublicRtspModule {}
