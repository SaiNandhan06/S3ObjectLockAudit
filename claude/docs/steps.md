For Part3 and Part4

### Why These Steps Matter

* **Governance Retention:** Protects an object from deletion until a set date/time, but a privileged user with `s3:BypassGovernanceRetention` (`admin-full`) can bypass the lock and delete it.
* **Legal Hold:** A strict binary flag (`ON`/`OFF`) that has **no bypass mechanism**. Even `admin-full` cannot delete an object with an active Legal Hold, regardless of whether the retention window has expired.
* Proving Legal Hold's independence requires waiting until retention has fully lapsed, testing that `admin-full` is still blocked, removing the hold, and then deleting successfully.

---

### Step-by-Step Commands

Looking at your screen, the retention time (`18:15 UTC` / `23:45 IST`) on `legal-doc.txt` (`dsrsy7I9LVONdjqnZYgiJOpOuFdn7Lh3`) has now passed. Run these final commands in your terminal:

#### 1. Turn Legal Hold Back ON

Re-apply the Legal Hold to test the protection:

```cmd
aws s3api put-object-legal-hold --bucket s3objectlock-auditlock-locked --key legal-doc.txt --legal-hold Status=ON --profile admin-full

```

#### 2. Confirm Retention Has Expired

Verify that the `RetainUntilDate` has passed the current time:

```cmd
aws s3api get-object-retention --bucket s3objectlock-auditlock-locked --key legal-doc.txt --profile admin-full

```

#### 3. Attempt Delete with `admin-full` (Expect FAIL)

Attempt to permanently delete the version using the bypass flag:

```cmd
aws s3api delete-object --bucket s3objectlock-auditlock-locked --key legal-doc.txt --version-id dsrsy7I9LVONdjqnZYgiJOpOuFdn7Lh3 --bypass-governance-retention --profile admin-full

```

* **Expected Result:** Fails with an `AccessDenied` / `object protected by object lock` error.
* **Why:** Retention is expired and governance bypass was provided, but Legal Hold strictly overrides both. **Save this terminal output as evidence.**

#### 4. Turn Legal Hold OFF

Remove the legal hold:

```cmd
aws s3api put-object-legal-hold --bucket s3objectlock-auditlock-locked --key legal-doc.txt --legal-hold Status=OFF --profile admin-full

```

#### 5. Delete Again (Expect SUCCESS)

Now delete the object version without any blockers:

```cmd
aws s3api delete-object --bucket s3objectlock-auditlock-locked --key legal-doc.txt --version-id dsrsy7I9LVONdjqnZYgiJOpOuFdn7Lh3 --profile admin-full

```

* **Expected Result:**
```json
{
    "VersionId": "dsrsy7I9LVONdjqnZYgiJOpOuFdn7Lh3"
}

```


* **Save this terminal output.** Pairing the failure from Step 3 with the success in Step 5 completes the required proof for Part 4.