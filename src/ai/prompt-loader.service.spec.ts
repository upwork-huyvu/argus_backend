import { InternalServerErrorException } from '@nestjs/common';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { PromptLoaderService } from './prompt-loader.service';

/**
 * Pin the contract:
 *   - the runtime prompt is required → loader throws on miss
 *   - the two knowledge prompts are optional → loader returns "" on miss
 *
 * We pivot the loader at a clean temp directory using PROMPTS_DIR so we can
 * place / remove files deterministically without touching the repo's real
 * `prompts/` folder.
 */
describe('PromptLoaderService', () => {
  let tmpDir: string;
  const originalEnv = process.env.PROMPTS_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-prompts-'));
    process.env.PROMPTS_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalEnv == null) delete process.env.PROMPTS_DIR;
    else process.env.PROMPTS_DIR = originalEnv;
  });

  it('throws InternalServerErrorException when the runtime prompt is missing', () => {
    const loader = new PromptLoaderService();
    expect(() => loader.getRuntimePrompt()).toThrow(InternalServerErrorException);
  });

  it('throws when the runtime prompt exists but is empty/whitespace', () => {
    fs.writeFileSync(path.join(tmpDir, 'ai-chat.runtime.prompt.txt'), '   \n  ');
    const loader = new PromptLoaderService();
    expect(() => loader.getRuntimePrompt()).toThrow(InternalServerErrorException);
  });

  it('returns the runtime prompt content when the file is present', () => {
    const body = 'CANARY runtime instructions';
    fs.writeFileSync(path.join(tmpDir, 'ai-chat.runtime.prompt.txt'), body);
    const loader = new PromptLoaderService();
    expect(loader.getRuntimePrompt()).toBe(body);
    // Cached on second call
    expect(loader.getRuntimePrompt()).toBe(body);
  });

  it('returns "" for missing optional prompts (app detail / drone features)', () => {
    fs.writeFileSync(path.join(tmpDir, 'ai-chat.runtime.prompt.txt'), 'x');
    const loader = new PromptLoaderService();
    expect(loader.getAppDetailPrompt()).toBe('');
    expect(loader.getDroneFeaturesPrompt()).toBe('');
  });

  it('returns content for optional prompts when they exist', () => {
    fs.writeFileSync(path.join(tmpDir, 'ai-chat.runtime.prompt.txt'), 'x');
    fs.writeFileSync(path.join(tmpDir, 'argus.detail.prompt.txt'), 'APP');
    fs.writeFileSync(path.join(tmpDir, 'drone.features.prompt.txt'), 'DRONE');
    const loader = new PromptLoaderService();
    expect(loader.getAppDetailPrompt()).toBe('APP');
    expect(loader.getDroneFeaturesPrompt()).toBe('DRONE');
  });
});
