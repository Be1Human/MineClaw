#!/usr/bin/env node
import { runWorkspaceCli } from '../scripts/testing-workspace-cli-core.mjs';

runWorkspaceCli({
  moduleUrl: import.meta.url,
  workspace: 'test-case',
  manifestRelative: 'test-case/manifest.json',
  entriesKey: 'collections',
  selectorName: 'domain',
});
