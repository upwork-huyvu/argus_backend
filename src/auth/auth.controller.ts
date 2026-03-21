import { Body, Controller, Post } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { LoginRequestDto } from "./dto/login-request.dto";
import { RegisterRequestDto } from "./dto/register-request.dto";
import { ApiBody, ApiOkResponse, ApiResponse, ApiTags } from "@nestjs/swagger";

const AuthUserResponseSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    username: { type: "string" },
    role: {
      type: "string",
      enum: ["treycor_operator", "client_admin", "viewer"],
    },
    permissions: {
      type: "object",
      properties: {
        fullControl: { type: "boolean" },
        canCustomize: { type: "boolean" },
        canEdit: { type: "boolean" },
        canToggle: { type: "boolean" },
        canDuplicate: { type: "boolean" },
      },
      required: [
        "fullControl",
        "canCustomize",
        "canEdit",
        "canToggle",
        "canDuplicate",
      ],
    },
  },
  required: ["name", "username", "role", "permissions"],
};

@Controller("auth")
@ApiTags("auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiBody({
    type: LoginRequestDto,
    examples: {
      default: {
        value: { username: "admin", password: "admin" },
      },
    },
  })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: {
        accessToken: { type: "string" },
        user: AuthUserResponseSchema,
      },
      required: ["accessToken", "user"],
    },
    examples: {
      success: {
        summary: "Successful login",
        value: {
          accessToken: "<jwt>",
          user: {
            name: "Admin User",
            username: "admin",
            role: "treycor_operator",
            permissions: {
              fullControl: true,
              canCustomize: true,
              canEdit: true,
              canToggle: true,
              canDuplicate: true,
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    schema: { type: "object", properties: { message: { type: "string" } } },
    description: "Invalid credentials",
    examples: {
      invalid: {
        summary: "Invalid credentials",
        value: { message: "Invalid credentials." },
      },
    },
  })
  @Post("login")
  async login(@Body() body: LoginRequestDto) {
    return this.authService.login(body.username, body.password);
  }

  @ApiBody({
    type: RegisterRequestDto,
    examples: {
      default: {
        value: { name: "New User", username: "client", password: "admin", role: "client_admin" },
      },
    },
  })
  @ApiOkResponse({
    schema: {
      type: "object",
      properties: {
        accessToken: { type: "string" },
        user: AuthUserResponseSchema,
      },
      required: ["accessToken", "user"],
    },
    examples: {
      success: {
        summary: "Successful registration",
        value: {
          accessToken: "<jwt>",
          user: {
            name: "New User",
            username: "client",
            role: "client_admin",
            permissions: {
              fullControl: false,
              canCustomize: true,
              canEdit: true,
              canToggle: true,
              canDuplicate: true,
            },
          },
        },
      },
    },
  })
  @Post("register")
  async register(@Body() body: RegisterRequestDto) {
    return this.authService.register(body);
  }
}

