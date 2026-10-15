/**
 * 当前内置 Project Type 的阶段词汇。
 *
 * 它们是 V1 已有的固定定义，而不是可由调用方扩展的注册表。后续若引入版本化配置，
 * 必须在新的事实 Owner 与迁移边界内替换本定义，不能让 SET_PHASE 接受任意字符串。
 */
export const PHASES_BY_PROJECT_TYPE = {
    GENERAL: ['PLANNING', 'EXECUTING', 'REVIEW'],
    THESIS: ['TOPIC', 'LITERATURE', 'METHOD', 'EXPERIMENT', 'WRITING', 'REVIEW'],
    DEVELOPMENT: ['DISCOVERY', 'DESIGN', 'IMPLEMENTATION', 'VALIDATION', 'RELEASE'],
};
export const INITIAL_PHASE_BY_PROJECT_TYPE = {
    GENERAL: 'PLANNING',
    THESIS: 'TOPIC',
    DEVELOPMENT: 'DISCOVERY',
};
export function isPhaseOfProjectType(projectType, phaseKey) {
    return PHASES_BY_PROJECT_TYPE[projectType].includes(phaseKey);
}
