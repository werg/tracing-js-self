// JSON Number conversion can change a language-neutral integer before the
// independent source sees it. Inspect the original tokens; never infer a new
// runtime input type or coerce an observed result to hide that loss.
import ts from 'typescript';

function integerLoss(lexeme){
  const match=/^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(lexeme);
  if(!match)throw new TypeError('Invalid canonical JSON number token');
  const fraction=match[3]??'';
  let digits=(match[2]+fraction).replace(/^0+/,'')||'0';
  if(digits==='0')return null;
  let zeros=Number(match[4]??0)-fraction.length;
  if(zeros<0){
    const cut=-zeros;
    // Fractional canonical values retain the ordinary Number contract. This
    // check concerns exact mathematical integers, including exponent notation.
    if(cut>digits.length||!/^[0]*$/.test(digits.slice(digits.length-cut)))return null;
    digits=digits.slice(0,digits.length-cut);zeros=0;
  }
  const sign=match[1],number=Number(lexeme);
  const observedInteger=Number.isFinite(number)&&Number.isInteger(number)?BigInt(number).toString():null;
  const length=sign.length+digits.length+zeros;
  if(observedInteger!==null&&length===observedInteger.length&&
      observedInteger===sign+digits+'0'.repeat(zeros))return null;
  return {lexeme,canonicalInteger:length<=4096?sign+digits+'0'.repeat(zeros):null,
    observedNumber:String(number),observedInteger};
}

export function inspectCanonicalInputPrecision(source,{slug}={}){
  if(typeof source!=='string'||typeof slug!=='string'||!slug)
    throw new TypeError('Canonical input precision requires source text and exercise identity');
  // The TypeScript parser supplies spans on Node 20 as well as newer versions;
  // JSON.parse remains the authority that the complete document is valid JSON.
  JSON.parse(source);
  const syntax=ts.parseJsonText('canonical-data.json',source);
  if(syntax.parseDiagnostics.length)throw new TypeError('Invalid canonical JSON syntax');
  const lossesByCase={},seen=new Set();
  function fields(node){
    const result=new Map();
    for(const property of node.properties){
      if(!ts.isPropertyAssignment(property)||!ts.isStringLiteral(property.name))
        throw new TypeError('Non-JSON canonical property');
      const key=property.name.text;
      if(result.has(key))throw new TypeError('Duplicate canonical JSON property '+key);
      result.set(key,property.initializer);
    }
    return result;
  }
  function input(node,path,losses){
    if(ts.isObjectLiteralExpression(node)){
      for(const [key,value] of fields(node))input(value,[...path,key],losses);
    }else if(ts.isArrayLiteralExpression(node)){
      node.elements.forEach((value,index)=>input(value,[...path,index],losses));
    }else if(ts.isNumericLiteral(node)||ts.isPrefixUnaryExpression(node)){
      const loss=integerLoss(node.getText(syntax));
      if(loss)losses.push({...loss,path,span:{start:node.getStart(syntax),end:node.end}});
    }
  }
  function visit(node){
    if(ts.isObjectLiteralExpression(node)){
      const values=fields(node);
      if(values.has('input')&&values.has('expected')){
        const uuid=values.get('uuid');
        if(!uuid||!ts.isStringLiteral(uuid))throw new TypeError('Canonical input precision requires a UUID');
        const caseId=slug+'/'+uuid.text;
        if(seen.has(caseId))throw new TypeError('Duplicate canonical input identity '+caseId);
        seen.add(caseId);
        const losses=[];input(values.get('input'),['input'],losses);
        if(losses.length)lossesByCase[caseId]={schema:'canonical-input-precision/1',
          status:'unsupported',scope:'integer-valued-json-numbers',losses};
        return;
      }
      if(values.has('cases'))visit(values.get('cases'));
      return;
    }
    ts.forEachChild(node,visit);
  }
  visit(syntax);
  return lossesByCase;
}
