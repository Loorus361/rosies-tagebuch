import { notFound } from "next/navigation";
import { isRosieOwner, requireChatGPTUser } from "./chatgpt-auth";
import { FeedingApp } from "./FeedingApp";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  if (!(await isRosieOwner(user))) notFound();
  return <FeedingApp displayName={user.fullName ?? user.email} />;
}
