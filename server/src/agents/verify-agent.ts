import { createAgent } from "./agent.js";

const agent = await createAgent();
try {
  console.log(`model: ${agent.model}`);
  console.log(`packages (${agent.packages.length}): ${agent.packages.join(", ")}`);
  console.log("---");
  process.stdout.write("> hi\n");
  const reply = await agent.prompt("hi");
  console.log(reply);
  console.log("---");
  console.log("Pi SDK 内嵌验证成功");
} finally {
  agent.dispose();
  process.exit(0);
}
