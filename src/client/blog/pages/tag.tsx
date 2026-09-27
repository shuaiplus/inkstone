export default function TagPage({ username, name }: {
  username: string
  name: string
}) {
  return (
    <div>
      <h1 className="blog-page-title">Tag</h1>
      <p className="blog-page-muted">Tag "{name}" for {username} is not implemented yet.</p>
    </div>
  )
}
