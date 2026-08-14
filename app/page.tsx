import { requireChatGPTUser } from "./chatgpt-auth";
import { FeedingApp } from "./FeedingApp";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  return <FeedingApp displayName={user.fullName ?? user.email} />;
}
