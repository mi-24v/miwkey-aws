/** Only fixed type labels enter logs; messages, stacks, arbitrary names and bodies do not. */
const labels=new Set(['Error','TypeError','SyntaxError','RangeError','ReferenceError','URIError','EvalError','AggregateError','AbortError','TimeoutError','DeploymentRejected','CloudflareRejected','AccessDeniedException','InvalidParameterException','ClientException','ServiceNotActiveException','ClusterNotFoundException','ServiceNotFoundException','ThrottlingException','ResourceNotFoundException','ParameterNotFound']);
export function safeErrorType(error:unknown):string{
 try{
  if(error instanceof TypeError)return 'TypeError';
  if(error instanceof SyntaxError)return 'SyntaxError';
  if(error instanceof RangeError)return 'RangeError';
  if(error instanceof Error||error instanceof DOMException){
   const type=error.constructor.name;
   if(labels.has(type)&&type!=='Error')return type;
   const name=error.name;if(labels.has(name))return name;
  }
 }catch{/* Untrusted error properties must not break failure reporting. */}
 return 'Error';
}
