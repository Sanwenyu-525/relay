/** 验收快照装配的临时 vitest 配置：root 指向 workbench，include 只收本证据目录的装配脚本。 */
export default {
  root: "D:/Develop/Relay-Agent/apps/workbench",
  test: {
    environment: "node",
    include: ["D:/Develop/Relay-Agent/tmp/acceptance/agent-ui-final-closure/evidence/build-source-snapshot.mts"]
  }
};
