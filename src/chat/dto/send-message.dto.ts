import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class SendMessageDto {
  @ApiProperty({ example: "Copy that. Dispatching Falcon-2 now." })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  body: string;

  @ApiPropertyOptional({
    example: "text",
    description: "Message kind. Operators can emit 'system' for dispatch notices.",
    enum: ["text", "system"],
  })
  @IsOptional()
  @IsIn(["text", "system"])
  messageType?: "text" | "system";
}
