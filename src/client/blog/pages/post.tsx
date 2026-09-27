export default function PostPage({ username, slug }: {
  username: string
  slug: string
}) {
  return (
    <div>
      <h1 className="blog-page-title">Post</h1>
      <p className="blog-page-muted">Post "{slug}" for {username} is not implemented yet.</p>
    </div>
  )
}
