import {
  stripThinkTags,
  cleanJsonString,
  findJsonObject,
  extractJson,
  normalizePass,
  normalizeApproval,
  normalizeSeverity,
  formatDiffsForPrompt,
} from './agent-result-parser';

// ---------------------------------------------------------------------------
// stripThinkTags
// ---------------------------------------------------------------------------
describe('stripThinkTags', () => {
  it('removes a single <think> block', () => {
    expect(stripThinkTags('<think>reasoning</think>Answer')).toBe('Answer');
  });

  it('removes multiple <think> blocks', () => {
    const input = '<think>a</think>Hello <think>b</think>World';
    expect(stripThinkTags(input)).toBe('Hello World');
  });

  it('handles multiline content inside think tags', () => {
    const input = '<think>\nline1\nline2\n</think>Result';
    expect(stripThinkTags(input)).toBe('Result');
  });

  it('returns original string when no think tags present', () => {
    expect(stripThinkTags('no tags here')).toBe('no tags here');
  });

  it('handles empty think block', () => {
    expect(stripThinkTags('<think></think>Output')).toBe('Output');
  });

  it('handles string that is only a think block', () => {
    expect(stripThinkTags('<think>only thinking</think>')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// cleanJsonString
// ---------------------------------------------------------------------------
describe('cleanJsonString', () => {
  it('removes trailing comma before }', () => {
    expect(cleanJsonString('{"a": 1,}')).toBe('{"a": 1}');
  });

  it('removes trailing comma before ]', () => {
    expect(cleanJsonString('[1, 2, 3,]')).toBe('[1, 2, 3]');
  });

  it('removes trailing comma with whitespace before }', () => {
    expect(cleanJsonString('{"a": 1 , }')).toBe('{"a": 1 }');
  });

  it('replaces control characters with spaces', () => {
    const input = '{"a": "hello\x00world\x1F"}';
    const result = cleanJsonString(input);
    expect(result).not.toContain('\x00');
    expect(result).not.toContain('\x1F');
    expect(result).toContain('hello world');
  });

  it('leaves valid JSON untouched', () => {
    const valid = '{"passed": true, "findings": []}';
    expect(cleanJsonString(valid)).toBe(valid);
  });
});

// ---------------------------------------------------------------------------
// findJsonObject
// ---------------------------------------------------------------------------
describe('findJsonObject', () => {
  it('extracts JSON from code fence with json tag', () => {
    const input = '```json\n{"passed": true}\n```';
    expect(findJsonObject(input)).toBe('{"passed": true}');
  });

  it('extracts JSON from code fence without tag', () => {
    const input = '```\n{"key": "value"}\n```';
    expect(findJsonObject(input)).toBe('{"key": "value"}');
  });

  it('extracts JSON from raw text (no fences)', () => {
    const input = 'Here is the result: {"passed": false, "reason": "test"}';
    expect(findJsonObject(input)).toBe('{"passed": false, "reason": "test"}');
  });

  it('returns null when no JSON object present', () => {
    expect(findJsonObject('no json here')).toBeNull();
  });

  it('extracts the outermost JSON object from nested content', () => {
    const input = '{"outer": {"inner": true}}';
    expect(findJsonObject(input)).toBe('{"outer": {"inner": true}}');
  });

  it('handles empty object', () => {
    expect(findJsonObject('{}')).toBe('{}');
  });
});

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------
describe('extractJson', () => {
  describe('Strategy 1: completion marker', () => {
    it('extracts JSON after completion marker', () => {
      const content = 'Some text DONE {"passed": true}';
      const result = extractJson(content, 'DONE');
      expect(result).toBe('{"passed": true}');
    });

    it('falls through when marker is absent', () => {
      const content = '```json\n{"passed": false}\n```';
      const result = extractJson(content, 'MISSING_MARKER');
      expect(result).toBe('{"passed": false}');
    });
  });

  describe('Strategy 2: code fence', () => {
    it('extracts JSON from code fence', () => {
      const content =
        'Analysis complete:\n```json\n{"passed": true, "findings": []}\n```';
      const result = extractJson(content);
      expect(result).toBe('{"passed": true, "findings": []}');
    });
  });

  describe('Strategy 3: validated JSON with key indicator', () => {
    it('extracts last valid JSON containing key indicator', () => {
      const content =
        'Some text {"irrelevant": 1} more text {"passed": true, "findings": []}';
      const result = extractJson(content);
      expect(JSON.parse(result!)).toEqual({ passed: true, findings: [] });
    });

    it('uses custom key indicator', () => {
      const content = 'Result: {"approved": true, "comments": []}';
      const result = extractJson(content, undefined, 'approved');
      expect(JSON.parse(result!)).toEqual({ approved: true, comments: [] });
    });

    it('also matches "findings" as a secondary key', () => {
      const content = 'Result: {"findings": ["bug"]}';
      const result = extractJson(content, undefined, 'something_else');
      expect(JSON.parse(result!)).toEqual({ findings: ['bug'] });
    });
  });

  describe('Strategy 4: greedy match', () => {
    it('falls back to greedy match when other strategies fail', () => {
      // Content with "passed" buried in text that won't match strategy 3 patterns
      // but will match greedy
      const json = '{"passed": true, "summary": "all good"}';
      const content = `Here is my analysis.\n${json}`;
      const result = extractJson(content);
      expect(JSON.parse(result!)).toEqual({
        passed: true,
        summary: 'all good',
      });
    });
  });

  it('returns null when no JSON can be extracted', () => {
    expect(extractJson('no json at all')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// normalizePass
// ---------------------------------------------------------------------------
describe('normalizePass', () => {
  describe('boolean passed field', () => {
    it('returns true for passed: true', () => {
      expect(normalizePass({ passed: true })).toBe(true);
    });

    it('returns false for passed: false', () => {
      expect(normalizePass({ passed: false })).toBe(false);
    });
  });

  describe('string passed field', () => {
    it('returns true for passed: "true"', () => {
      expect(normalizePass({ passed: 'true' })).toBe(true);
    });

    it('returns true for passed: "True" (case insensitive)', () => {
      expect(normalizePass({ passed: 'True' })).toBe(true);
    });

    it('returns false for passed: "false"', () => {
      expect(normalizePass({ passed: 'false' })).toBe(false);
    });
  });

  describe('status field fallback', () => {
    it.each(['pass', 'passed', 'success', 'secure'])(
      'returns true for status: "%s"',
      (status) => {
        expect(normalizePass({ status })).toBe(true);
      },
    );

    it('returns false for status: "fail"', () => {
      expect(normalizePass({ status: 'fail' })).toBe(false);
    });

    it('handles uppercase status', () => {
      expect(normalizePass({ status: 'PASS' })).toBe(true);
    });
  });

  describe('result field fallback', () => {
    it.each(['pass', 'passed', 'success', 'secure'])(
      'returns true for result: "%s"',
      (result) => {
        expect(normalizePass({ result })).toBe(true);
      },
    );

    it('returns false for result: "fail"', () => {
      expect(normalizePass({ result: 'fail' })).toBe(false);
    });
  });

  it('returns false when no recognized field', () => {
    expect(normalizePass({})).toBe(false);
    expect(normalizePass({ something: 'else' })).toBe(false);
  });

  it('prefers passed over status', () => {
    expect(normalizePass({ passed: false, status: 'pass' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// normalizeApproval
// ---------------------------------------------------------------------------
describe('normalizeApproval', () => {
  describe('boolean approved field', () => {
    it('returns true for approved: true', () => {
      expect(normalizeApproval({ approved: true })).toBe(true);
    });

    it('returns false for approved: false', () => {
      expect(normalizeApproval({ approved: false })).toBe(false);
    });
  });

  describe('string approved field', () => {
    it('returns true for approved: "true"', () => {
      expect(normalizeApproval({ approved: 'true' })).toBe(true);
    });

    it('returns false for approved: "false"', () => {
      expect(normalizeApproval({ approved: 'false' })).toBe(false);
    });
  });

  describe('decision field fallback', () => {
    it.each(['approve', 'approved', 'pass'])(
      'returns true for decision: "%s"',
      (decision) => {
        expect(normalizeApproval({ decision })).toBe(true);
      },
    );

    it('returns false for decision: "reject"', () => {
      expect(normalizeApproval({ decision: 'reject' })).toBe(false);
    });
  });

  describe('verdict field fallback', () => {
    it.each(['approve', 'approved', 'pass'])(
      'returns true for verdict: "%s"',
      (verdict) => {
        expect(normalizeApproval({ verdict })).toBe(true);
      },
    );

    it('returns false for verdict: "reject"', () => {
      expect(normalizeApproval({ verdict: 'reject' })).toBe(false);
    });
  });

  it('returns false when no recognized field', () => {
    expect(normalizeApproval({})).toBe(false);
  });

  it('prefers approved over decision', () => {
    expect(normalizeApproval({ approved: false, decision: 'approve' })).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeSeverity
// ---------------------------------------------------------------------------
describe('normalizeSeverity', () => {
  describe('critical mappings', () => {
    it.each(['critical', 'error', 'high', 'blocker', 'CRITICAL', 'High'])(
      'maps "%s" to critical',
      (input) => {
        expect(normalizeSeverity(input)).toBe('critical');
      },
    );
  });

  describe('warning mappings', () => {
    it.each(['warning', 'warn', 'medium', 'moderate', 'major', 'WARNING'])(
      'maps "%s" to warning',
      (input) => {
        expect(normalizeSeverity(input)).toBe('warning');
      },
    );
  });

  describe('info mappings (default)', () => {
    it.each(['info', 'low', 'minor', 'note', 'suggestion', 'INFO'])(
      'maps "%s" to info',
      (input) => {
        expect(normalizeSeverity(input)).toBe('info');
      },
    );
  });

  it('defaults to info for null/undefined', () => {
    expect(normalizeSeverity(null)).toBe('info');
    expect(normalizeSeverity(undefined)).toBe('info');
  });

  it('handles whitespace around input', () => {
    expect(normalizeSeverity('  critical  ')).toBe('critical');
  });
});

// ---------------------------------------------------------------------------
// formatDiffsForPrompt
// ---------------------------------------------------------------------------
describe('formatDiffsForPrompt', () => {
  it('formats a new file diff', () => {
    const result = formatDiffsForPrompt([
      { new_path: 'src/app.ts', diff: '+console.log("hi")', new_file: true },
    ]);
    expect(result).toContain('[NEW] src/app.ts');
    expect(result).toContain('+console.log("hi")');
  });

  it('formats a deleted file diff', () => {
    const result = formatDiffsForPrompt([
      { new_path: 'old.ts', diff: '-old code', deleted_file: true },
    ]);
    expect(result).toContain('[DELETED] old.ts');
  });

  it('formats a renamed file diff', () => {
    const result = formatDiffsForPrompt([
      {
        new_path: 'new-name.ts',
        old_path: 'old-name.ts',
        diff: 'rename',
        renamed_file: true,
      },
    ]);
    expect(result).toContain('[RENAMED] new-name.ts');
  });

  it('formats a modified file diff', () => {
    const result = formatDiffsForPrompt([
      { new_path: 'file.ts', diff: '+ changed' },
    ]);
    expect(result).toContain('[MODIFIED] file.ts');
  });

  it('truncates long diffs', () => {
    const longDiff = 'x'.repeat(100);
    const result = formatDiffsForPrompt(
      [{ new_path: 'big.ts', diff: longDiff }],
      50,
    );
    expect(result).toContain('... (truncated)');
    expect(result).not.toContain('x'.repeat(100));
  });

  it('handles multiple diffs', () => {
    const result = formatDiffsForPrompt([
      { new_path: 'a.ts', diff: 'diff-a' },
      { new_path: 'b.ts', diff: 'diff-b', new_file: true },
    ]);
    expect(result).toContain('[MODIFIED] a.ts');
    expect(result).toContain('[NEW] b.ts');
  });
});
