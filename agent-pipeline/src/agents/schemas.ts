// JSON Schemas for each agent's structured result.

const str = { type: 'string' };
const strList = { type: 'array', items: str };

export const REQUIREMENT_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'false if nothing is worth doing now' },
    reason: str,
    requirement: {
      type: 'object',
      properties: {
        title: str,
        rationale: str,
        acceptanceCriteria: strList,
        risk: { type: 'string', enum: ['low', 'medium', 'high'] },
        areas: strList,
      },
      required: ['title', 'rationale', 'acceptanceCriteria', 'risk', 'areas'],
    },
  },
  required: ['found', 'reason'],
};

export const DEVELOPER_SCHEMA = {
  type: 'object',
  properties: { summary: str, filesChanged: strList, testsAdded: strList, openQuestions: strList },
  required: ['summary', 'filesChanged', 'testsAdded'],
};

export const TESTER_SCHEMA = {
  type: 'object',
  properties: { passed: { type: 'boolean' }, summary: str, testFiles: strList, failures: strList },
  required: ['passed', 'summary', 'testFiles', 'failures'],
};

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: { approve: { type: 'boolean' }, summary: str, blockingIssues: strList, suggestions: strList },
  required: ['approve', 'summary', 'blockingIssues'],
};

export const REDESIGN_SCHEMA = {
  type: 'object',
  properties: {
    docPath: str,
    summary: str,
    proposals: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: str, rationale: str, risk: { type: 'string', enum: ['low', 'medium', 'high'] } },
        required: ['title', 'rationale', 'risk'],
      },
    },
  },
  required: ['docPath', 'summary', 'proposals'],
};
