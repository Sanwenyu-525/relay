import { afterEach, expect, it, vi } from '../../../../apps/workbench/node_modules/vitest/dist/index.js';
import { activateRelayConnection, resetRelayConnectionForTest } from '../../../../apps/workbench/src/lib/relayConnection';
import { flush, mountWorkbench } from '../../../../apps/workbench/tests/mountApp';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const taskId = '55555555-5555-4555-8555-555555555555';
const root = `http://127.0.0.1:8787/api/v1/workspaces/${workspaceId}`;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); resetRelayConnectionForTest(); vi.unstubAllGlobals(); });
const response = (status: number, body: unknown) => ({ok:status === 200,status,json:async()=>body}) as Response;

for (const firstReadFails of [false, true]) {
  it(`refresh should reload next-action title after ${firstReadFails ? 'a transient error' : 'a task rename'}`, async () => {
    let reads = 0;
    let fresh = false;
    activateRelayConnection({baseUrl:'http://127.0.0.1:8787',workspaceId,bearerToken:'audit-token-012345678901234567890123'});
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/attention/interventions')) return response(200,{items:[]});
      if (url === `${root}/projects?status=active`) return response(200,{items:[{
        id:projectId,title:'审查项目',project_type:'GENERAL',archived_at:null,archive_status:'ACTIVE',
        revision:'2',state_revision:'3',phase_key:'PLANNING',next_action_task_id:taskId,
        created_at:'2026-09-28T00:00:00Z',updated_at:'2026-09-28T00:00:00Z'
      }],next_cursor:null});
      if (url === `${root}/tasks/${taskId}`) {
        reads++;
        if (firstReadFails && !fresh) return response(503,{code:'UNAVAILABLE',detail:'temporary'});
        return response(200,{
          id:taskId,title:fresh ? '修订后的下一步' : '旧下一步',project_id:projectId,status:'INBOX',mode:'ME',revision:'2',
          executor:{kind:'HUMAN',run_id:null},current_completion_id:null,waiting_reason:null,
          blocking_task_ids:[],unresolved_blocker_ids:[],allowed_actions:[],
          acceptance:{acceptance_revision:'1',objective:'核对下一步',source:'HUMAN',criteria:[]},dependencies:[]
        });
      }
      throw new Error(`unexpected request ${url}`);
    }));
    const mounted = await mountWorkbench('/projects'); cleanup = mounted.unmount;
    await flush(30);
    expect(reads).toBe(1);
    fresh = true;
    await mounted.wrapper.get('[data-testid="projects-live-refresh"]').trigger('click');
    await flush(40);
    expect(mounted.wrapper.get(`[data-testid="project-row-${projectId}"]`).text()).toContain('修订后的下一步');
    expect(reads).toBe(2);
  });
}
