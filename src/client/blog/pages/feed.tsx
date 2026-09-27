export default function FeedPage({ username }: {
  username: string
}) {
  return (
    <div>
      <h1 className="blog-page-title">Articles</h1>
      <p className="blog-page-muted">Feed for {username} is not implemented yet.</p>
    </div>
  )
}
