import test from 'node:test';
import assert from 'node:assert/strict';
import {readPinnedEcma262Specification} from '../src/conformance/test262-specification.js';
import {classifyImportDeferParseFailure,extractImportDeferGrammarEvidence} from '../src/conformance/test262-scope-annotations.js';

const {bytes}=readPinnedEcma262Specification();
const grammar=extractImportDeferGrammarEvidence(bytes);
const row=(reason,line='')=>({id:'0'.repeat(64),path:'test/example.js',stage:'parseStatic',status:'failed',
  errorType:'SyntaxError',phase:'parse',reason,features:['import-defer'],line});

test('pinned grammar evidence hashes the three exact import productions',()=>{
  assert.deepEqual(grammar,{
    ImportDeclaration:{id:'prod-ImportDeclaration',sha256:'fad54aff3713cc675476b177849a85619023e43e78dbdc8ebbaf0905951c6eae',bytes:952},
    ImportMeta:{id:'prod-ImportMeta',sha256:'a911dead533a77a79f419711b46496a58a20456529dae744a8043761e386bd03',bytes:297},
    ImportCall:{id:'prod-ImportCall',sha256:'e5035f9df2c3f6ee22871ea0a78e8dd036f1457c69e9b4ec8403d720aeccc848',bytes:1321}
  });
  const changed=Buffer.from(bytes);const at=changed.indexOf(Buffer.from('<emu-production name="ImportMeta" id="prod-ImportMeta">'));
  changed[at+33]^=1;
  assert.throws(()=>extractImportDeferGrammarEvidence(changed),/production bytes differ/);
});

test('static import defer requires the exact failed-token location and grammar evidence',()=>{
  const source='/* header */\nimport defer * as ns from "./dep.js";\n';
  const result=classifyImportDeferParseFailure(row('Unexpected parser SyntaxError: Unexpected token (2:13)'),source,grammar);
  assert.deepEqual(result,{status:'outside-pinned-grammar',rule:'static-import-defer',
    location:{line:2,column:13},evidence:['ImportDeclaration']});
  assert.equal(classifyImportDeferParseFailure(row('Unexpected parser SyntaxError: Unexpected token (2:13)'),source,
    {ImportDeclaration:null}).status,'unclassified');
});

test('import.defer is separately checked against ImportMeta and ImportCall productions',()=>{
  const source='import.defer("./dep.js").then(() => {});\n';
  const result=classifyImportDeferParseFailure(row("Unexpected parser SyntaxError: The only valid meta property for import is 'import.meta' (1:7)"),source,grammar);
  assert.deepEqual(result,{status:'outside-pinned-grammar',rule:'import-defer-meta-member',
    location:{line:1,column:7},evidence:['ImportMeta','ImportCall']});
  assert.equal(classifyImportDeferParseFailure(row("Unexpected parser SyntaxError: The only valid meta property for import is 'import.meta' (1:7)"),source,
    {ImportMeta:grammar.ImportMeta,ImportCall:null}).status,'unclassified');
});

test('comments, strings, unrelated errors and dynamic import options remain unclassified',()=>{
  const staticError='Unexpected parser SyntaxError: Unexpected token (1:13)';
  const metaError="Unexpected parser SyntaxError: The only valid meta property for import is 'import.meta' (1:7)";
  for(const [reason,source] of [
    [staticError,'// import defer * as ns from "./dep.js";\n'],
    [staticError,'const s = "import defer * as ns from ./dep.js";\n'],
    ['Unexpected parser SyntaxError: Unexpected token (1:14)','import defer * as ns from "./dep.js";\n'],
    ['Unexpected parser SyntaxError: Unexpected token (1:0)','const x = ;\n'],
    [metaError,'const s = "import.defer(\"x\")";\n'],
    [metaError,'import("./dep.js", { with: { type: "json" }, defer: true });\n']
  ]) assert.equal(classifyImportDeferParseFailure(row(reason),source,grammar).status,'unclassified');
  assert.equal(classifyImportDeferParseFailure({...row(staticError),features:['other-feature']},
    'import defer * as ns from "./dep.js";\n',grammar).status,'unclassified');
});
