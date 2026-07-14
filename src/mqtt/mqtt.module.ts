import { Module } from "@nestjs/common";
import { MqttService } from "./mqtt.service";
import { MqttMessageHandlerService } from "./mqtt-message-handler.service";

/**
 * MQTT transport. SupabaseModule is @Global so no explicit import is needed.
 * Exports MqttService so DrawerCommandsModule can publish commands.
 */
@Module({
  providers: [MqttService, MqttMessageHandlerService],
  exports: [MqttService],
})
export class MqttModule {}
