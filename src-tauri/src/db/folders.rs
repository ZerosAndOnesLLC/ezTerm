use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{AppError, Result};

#[derive(Clone, Debug, Serialize, Deserialize, sqlx::FromRow)]
pub struct Folder {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub sort: i64,
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Folder>> {
    Ok(sqlx::query_as::<_, Folder>(
        "SELECT id, parent_id, name, sort FROM folders ORDER BY parent_id, sort, id",
    )
    .fetch_all(pool)
    .await?)
}

pub async fn create(pool: &SqlitePool, parent_id: Option<i64>, name: &str) -> Result<Folder> {
    let id = sqlx::query("INSERT INTO folders (parent_id, name) VALUES (?, ?)")
        .bind(parent_id)
        .bind(name)
        .execute(pool)
        .await?
        .last_insert_rowid();
    Ok(Folder {
        id,
        parent_id,
        name: name.into(),
        sort: 0,
    })
}

pub async fn rename(pool: &SqlitePool, id: i64, name: &str) -> Result<()> {
    sqlx::query("UPDATE folders SET name = ? WHERE id = ?")
        .bind(name)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete(pool: &SqlitePool, id: i64) -> Result<()> {
    sqlx::query("DELETE FROM folders WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn mv(pool: &SqlitePool, id: i64, parent_id: Option<i64>, sort: i64) -> Result<()> {
    if let Some(pid) = parent_id {
        if pid == id {
            return Err(AppError::Validation("cannot move folder into itself".into()));
        }
        // Walk the prospective parent's ancestor chain. If `id` appears anywhere
        // in it, accepting the move would create a cycle.
        let cyclic: Option<(i64,)> = sqlx::query_as(
            "WITH RECURSIVE ancestors(id) AS (\
               SELECT id FROM folders WHERE id = ? \
               UNION ALL \
               SELECT f.parent_id FROM folders f JOIN ancestors a ON f.id = a.id \
                 WHERE f.parent_id IS NOT NULL\
             ) SELECT 1 FROM ancestors WHERE id = ?",
        )
        .bind(pid)
        .bind(id)
        .fetch_optional(pool)
        .await?;
        if cyclic.is_some() {
            return Err(AppError::Validation("would create cycle".into()));
        }
    }
    sqlx::query("UPDATE folders SET parent_id = ?, sort = ? WHERE id = ?")
        .bind(parent_id)
        .bind(sort)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Renumber sibling folders under `parent_id` according to `ids_in_order`.
/// Each position gets `sort = position * 10`. Folders under the same parent
/// that aren't in the list are untouched — caller guarantees the complete
/// sibling set is passed.
pub async fn reorder(
    pool: &SqlitePool,
    parent_id: Option<i64>,
    ids_in_order: &[i64],
) -> Result<()> {
    let mut tx = pool.begin().await?;
    for (idx, id) in ids_in_order.iter().enumerate() {
        // Cycle-check isn't needed here: we're renumbering within a
        // single parent, so every id already has `parent_id` as its
        // parent (caller guarantees this).
        let sort = (idx as i64) * 10;
        sqlx::query("UPDATE folders SET parent_id = ?, sort = ? WHERE id = ?")
            .bind(parent_id)
            .bind(sort)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let p = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::init_pool_from_pool(&p).await.unwrap();
        p
    }

    #[tokio::test]
    async fn create_list_rename_delete() {
        let p = pool().await;
        let a = create(&p, None, "prod").await.unwrap();
        let _ = create(&p, Some(a.id), "web").await.unwrap();
        assert_eq!(list(&p).await.unwrap().len(), 2);
        rename(&p, a.id, "production").await.unwrap();
        delete(&p, a.id).await.unwrap();
        // cascade deletes children
        assert_eq!(list(&p).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn mv_rejects_cycle() {
        let p = pool().await;
        // Build a -> b -> c chain.
        let a = create(&p, None, "a").await.unwrap();
        let b = create(&p, Some(a.id), "b").await.unwrap();
        let c = create(&p, Some(b.id), "c").await.unwrap();

        // 1. Self-parent rejected.
        let err = mv(&p, a.id, Some(a.id), 0).await.err().unwrap();
        assert!(matches!(err, AppError::Validation(_)), "self-parent must be rejected");

        // 2. Moving an ancestor under a descendant is a cycle.
        let err = mv(&p, a.id, Some(c.id), 0).await.err().unwrap();
        assert!(matches!(err, AppError::Validation(_)), "ancestor->descendant must be rejected");

        // 3. A legal move still works (detach b to root).
        mv(&p, b.id, None, 0).await.unwrap();
        let rows = list(&p).await.unwrap();
        let b_row = rows.iter().find(|f| f.id == b.id).unwrap();
        assert_eq!(b_row.parent_id, None);
    }

    #[tokio::test]
    async fn mv_allows_valid_nesting() {
        let p = pool().await;
        let a = create(&p, None, "a").await.unwrap();
        let b = create(&p, None, "b").await.unwrap();
        // Nest b under a — both currently siblings at root, no ancestor conflict.
        mv(&p, b.id, Some(a.id), 0).await.unwrap();
        let rows = list(&p).await.unwrap();
        let b_row = rows.iter().find(|f| f.id == b.id).unwrap();
        assert_eq!(b_row.parent_id, Some(a.id));
    }
}
