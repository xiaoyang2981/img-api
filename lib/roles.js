export const ROLES = ['owner', 'admin', 'moderator', 'member'];

export const ROLE_LABELS = {
    owner: '站长',
    admin: '管理员',
    moderator: '审核员',
    member: '成员'
};

export const roleLabel = (role) => ROLE_LABELS[role] || role || '成员';

export const normalizeRole = (role) => (ROLES.includes(role) ? role : 'member');

export const isOwner = (role) => role === 'owner';
export const isAdmin = (role) => role === 'admin';
export const isModerator = (role) => role === 'moderator';
export const isMember = (role) => role === 'member';

export const canManageSettings = (role) => role === 'owner' || role === 'admin';
export const canEditPort = (role) => role === 'owner';
export const canManageUsers = (role) => role === 'owner' || role === 'admin';
export const canReview = (role) => role === 'owner' || role === 'admin' || role === 'moderator';
export const canUpload = (role) => role === 'owner' || role === 'admin' || role === 'member';
export const canAccessDashboard = (role) => role !== 'moderator';

// 管理员只能管理审核员和成员；站长可以管理管理员及以下，但不能把别人提升为站长。
export const assignableRoles = (role) => {
    if (role === 'owner') return ['admin', 'moderator', 'member'];
    if (role === 'admin') return ['moderator', 'member'];
    return [];
};

export const canAssignRole = (actorRole, targetRole) => assignableRoles(actorRole).includes(targetRole);

export const canManageUser = (actor, target) => {
    if (!actor || !target) return false;
    if (actor.role === 'owner') {
        return target.role !== 'owner' || actor.id === target.id;
    }
    if (actor.role === 'admin') {
        return target.role === 'moderator' || target.role === 'member';
    }
    return false;
};

export const canEditImage = (user, image) => {
    if (!user || !image) return false;
    if (user.role === 'owner' || user.role === 'admin') return true;
    return user.role === 'member' && image.ownerId === user.id;
};

export const canViewImage = (user, image) => {
    if (!image) return false;
    if (image.status === 'approved' && image.visible !== false) return true;
    if (!user) return false;
    return canReview(user.role) || image.ownerId === user.id;
};
