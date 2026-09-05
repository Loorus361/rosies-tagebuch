import { berlinToday, getFeedingState } from "@/db/feeding";
import { notFound } from "next/navigation";
import { isRosieOwner, requireChatGPTUser } from "./chatgpt-auth";
import { FeedingApp } from "./FeedingApp";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  if (!(await isRosieOwner(user))) notFound();
  let initialState = null;
  try {
    initialState = await getFeedingState(user.userId, berlinToday());
  } catch (error) {
    console.error("Initial feeding load failed", error);
  }
  return <FeedingApp displayName={user.fullName ?? user.email} initialState={initialState} />;
}
