// Task-independent form constraints for a conventional grammar-aware decoder.
// This grammar never supplies a source program, expected value or public-state
// identity. The strict V6 codec remains authoritative for canonical numbers,
// Unicode identifier categories, budgets and action-specific field meaning.
export function syntaxOnlyV6Grammar(){
  return String.raw`root ::= compute | choose | binding | allocate | read | write | call | transfer | returned | thrown | request | job | promise | awaited | resume | summarize | end
compute ::= "compute " expression " => " value (" as " name)? invocation? site?
choose ::= "choose " expression " => " value " -> " path invocation? site?
path ::= "then" | "else" | "use-left" | "evaluate-right"
binding ::= name " = " value (" from " name)? invocation?
allocate ::= "new " reference " " allocation-kind " " properties (" length " uint)? (" code " string)? (" captures " captures)? invocation?
allocation-kind ::= "object" | "array" | "closure" | "set" | "regexp"
properties ::= "{" (string ": " value (", " string ": " value)*)? "}"
captures ::= "{" (name ": " name (", " name ": " name)*)? "}"
read ::= "read " reference "[" string "] => " value " absent"? invocation?
write ::= "write " reference "[" string "] = " value " absent"? invocation?
call ::= "call " symbol arguments " this " value " -> @" routed-id invocation?
transfer ::= "transfer " completion " " value " via " json-value invocation?
completion ::= "return" | "throw" | "cleanup"
returned ::= "return " value invocation?
thrown ::= "throw " value invocation?
request ::= "request " reference " " symbol arguments " payload " json-value (" promise " reference)? invocation site
job ::= "job " job-action " " reference " for @" routed-id (" result " json-value)? (" closure " reference)?
job-action ::= "enqueue" | "dispatch" | "complete"
promise ::= "promise " promise-action invocation?
promise-action ::= "create " reference | "resolve " reference " = " value | "reject " reference " = " value | "adopt " reference " -> " reference | "react " reference " " reaction " as " reference (" closure " reference)? (" reject " reference)? (" target " reference)?
reaction ::= "then" | "catch" | "finally"
awaited ::= "await " reference " as " reference (" returns " reference)? invocation
resume ::= "resume " reference " " status " " value invocation
status ::= "fulfilled" | "rejected"
summarize ::= "evaluate " name arguments " => " value (" choosing " decisions | " over " uint " items into " name)? invocation?
decisions ::= decision (", " decision)*
decision ::= uint ".." uint ":" selection
selection ::= "consequent" | "alternate" | "left" | "right"
end ::= "end return" | "end throw"
invocation ::= " in @" routed-id
site ::= " at " uint ".." uint
arguments ::= "(" (value (", " value)*)? ")"
expression ::= value | name | "local(" string ")" | reference "[" string "]" | "random()" | "(" unary " " expression ")" | "(" expression " " binary " " expression ")"
unary ::= "!" | "+" | "-" | "~" | "typeof" | "void"
binary ::= "+" | "-" | "*" | "/" | "%" | "**" | "<" | "<=" | ">" | ">=" | "===" | "!==" | "==" | "!=" | "&" | "|" | "^" | "<<" | ">>" | ">>>"
value ::= string | bigint | number | "undefined" | "null" | "true" | "false" | "NaN" | "Infinity" | "-Infinity" | reference
reference ::= "@" identity
identity ::= [a-z] [a-z0-9]*
routed-id ::= [a-z] [a-z0-9:_-]*
symbol ::= name ("." name)* | string
name ::= name-start name-continue*
name-start ::= [a-zA-Z_$] | [^\x00-\x7F]
name-continue ::= [a-zA-Z0-9_$] | [^\x00-\x7F]
bigint ::= "-"? uint "n"
number ::= "-"? uint ("." [0-9]+)? ("e" ("+" | "-") [0-9]+)?
uint ::= "0" | [1-9] [0-9]*
string ::= "\"" char* "\""
char ::= [^"\\\x00-\x1F] | "\\" (["\\bfnrt] | "u" hex hex hex hex)
hex ::= [0-9a-f]
json-value ::= object | array | string | number | "true" | "false" | "null"
object ::= "{" (string ":" json-value ("," string ":" json-value)*)? "}"
array ::= "[" (json-value ("," json-value)*)? "]"
`;
}
