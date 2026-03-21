import { loadPrompt } from './prompt-loader';
import * as fs from 'fs';
import * as path from 'path';

// We mock fs so we don't depend on actual file layout at test time.
jest.mock('fs');

const mockedFs = fs as jest.Mocked<typeof fs>;

describe('loadPrompt', () => {
  // Clear the internal cache between tests by re-importing the module
  // would be complex, so instead we test with unique names per test.

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads an existing prompt file from the primary path', () => {
    const promptContent = '# System Prompt\nYou are an agent.';

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(promptContent);

    const result = loadPrompt('test-primary-' + Date.now());

    expect(result).toBe(promptContent);
    expect(mockedFs.readFileSync).toHaveBeenCalledWith(
      expect.stringContaining('prompts'),
      'utf-8',
    );
  });

  it('falls back to the secondary path when primary does not exist', () => {
    const promptContent = '# Fallback Prompt';
    const uniqueName = 'test-fallback-' + Date.now();

    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readFileSync.mockReturnValue(promptContent);

    const result = loadPrompt(uniqueName);

    expect(result).toBe(promptContent);
    // When primary doesn't exist, it reads from the fallback path
    const readPath = mockedFs.readFileSync.mock.calls[0][0] as string;
    expect(readPath).not.toContain(path.join('prompts', `${uniqueName}.md`));
  });

  it('returns cached value on second call (no second read)', () => {
    const promptContent = '# Cached Prompt';
    const uniqueName = 'test-cached-' + Date.now();

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(promptContent);

    const result1 = loadPrompt(uniqueName);

    // Record call count after first load
    const callsAfterFirst = mockedFs.readFileSync.mock.calls.length;

    const result2 = loadPrompt(uniqueName);

    expect(result1).toBe(promptContent);
    expect(result2).toBe(promptContent);
    // readFileSync should NOT have been called again — cache hit
    expect(mockedFs.readFileSync.mock.calls.length).toBe(callsAfterFirst);
  });

  it('throws a readable error for a non-existent prompt file', () => {
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.readFileSync.mockImplementation(() => {
      throw new Error(
        "ENOENT: no such file or directory, open '/fake/path/does-not-exist.md'",
      );
    });

    expect(() => loadPrompt('does-not-exist-' + Date.now())).toThrow('ENOENT');
  });
});
