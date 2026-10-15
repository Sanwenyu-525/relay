export interface RelayTaskChainExecution {
 contextSources?:readonly {kind:'KNOWLEDGE'|'MEMORY'|'DECISION';rootId:string;version:string}[];
 fileReadAction?:{connectionId:string;resourceId:string;relativeTarget:string};
 toolLoopAction?:{resourceId:string;connections:{FILE_QUERY?:string;FILE_READ?:string;GIT_READ?:string;FILE_WRITE?:string;CLI_RUN?:string};allowedTools:readonly ('list_directory'|'find_paths'|'search_text'|'read_file'|'git_status'|'git_diff'|'git_log'|'apply_changeset'|'read_change_set'|'run_check')[];maxRounds:number;maxToolCalls:number};
 scopeGrant?:{resourceId:string;allowedActions:readonly ('APPLY_CHANGESET'|'CLI_RUN')[];checks:readonly {id:string;executable:string;args:readonly string[];executableSha256:string;maxOutputBytes?:number}[];expiresAt?:string};
 methodMessageId?:string;
}
export interface RelayTaskChainCreate {commandId:string;projectId:string;title:string;confirmed:true;tasks:readonly {taskId:string;expectedRevision:string;expectedAcceptanceRevision:string;execution?:RelayTaskChainExecution}[]}
export interface RelayTaskChainAuthorization {commandId:string;chainId:string;expectedRevision:string;confirmed:true;maxTasks:number;maxModelCalls:number;expiresAt:string}
export interface RelayTaskChainControl {commandId:string;chainId:string;expectedRevision:string;action:'PAUSE'|'REVOKE';reason:string}
export interface RelayTaskChainResult {chainId:string;projectId:string;status:string;revision:string}
export interface RelayTaskChain extends RelayTaskChainResult {title:string;baseline:Record<string,unknown>;maxTasks:number;maxModelCalls:number;taskReservations:number;callsStarted:number;expiresAt:string|null;reason:string|null;controlRequestId:string|null;authorizationHistory:Record<string,unknown>[];items:Record<string,unknown>[];modelUsage:Record<string,unknown>}
